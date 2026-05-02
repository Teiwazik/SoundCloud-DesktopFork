//! Direct anon download from the SoundCloud public API v2.
//!
//! Mirrors the streaming server's `anon` flow but performs every request
//! straight from the user's machine — no proxy hops. Used as a fallback
//! between local storage and the streaming server: if the user can reach
//! SoundCloud directly, we save a round trip to our infra.

mod hls;

use bytes::Bytes;
use reqwest::Client;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;

use hls::{download_hls_full, download_progressive};

const SC_BASE_URL: &str = "https://soundcloud.com";
const SC_API_V2: &str = "https://api-v2.soundcloud.com";
const SC_USER_AGENT: &str =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/// Preset preference: progressive first (one GET, no chunk failures), then
/// HLS by preset preference.
const PRESET_ORDER: &[&str] = &["mp3_1_0", "aac_160k", "opus_0_0", "abr_sq"];

/// Circuit breaker: trip after this many consecutive network failures so users
/// behind a regulator that blocks SC don't pay 1.5s connect-timeout per track.
const FAIL_THRESHOLD: u8 = 3;
const COOLDOWN_SECS: u64 = 300;

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Debug, serde::Deserialize)]
pub struct TranscodingFormat {
    pub protocol: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
pub struct Transcoding {
    pub url: String,
    pub preset: Option<String>,
    pub snipped: Option<bool>,
    pub format: Option<TranscodingFormat>,
}

#[derive(Debug, serde::Deserialize)]
pub struct TrackMedia {
    pub transcodings: Option<Vec<Transcoding>>,
}

#[derive(Debug, serde::Deserialize)]
pub struct ResolvedTrack {
    pub media: Option<TrackMedia>,
}

#[derive(Debug, serde::Deserialize)]
struct TranscodingResolveResponse {
    url: String,
}

/// Successful download from SC anon API.
pub struct AnonStreamResult {
    pub data: Bytes,
}

/// Caches a public `client_id` extracted from soundcloud.com homepage hydration.
/// Includes a circuit breaker so users with SC blocked don't eat connect-timeouts
/// on every track.
#[derive(Clone)]
pub struct AnonClient {
    client: Client,
    client_id: Arc<RwLock<Option<String>>>,
    fail_count: Arc<AtomicU8>,
    cooldown_until: Arc<AtomicU64>,
}

impl AnonClient {
    pub fn new(client: Client) -> Self {
        Self {
            client,
            client_id: Arc::new(RwLock::new(None)),
            fail_count: Arc::new(AtomicU8::new(0)),
            cooldown_until: Arc::new(AtomicU64::new(0)),
        }
    }

    fn in_cooldown(&self) -> bool {
        self.cooldown_until.load(Ordering::Relaxed) > now_secs()
    }

    fn note_success(&self) {
        self.fail_count.store(0, Ordering::Relaxed);
        self.cooldown_until.store(0, Ordering::Relaxed);
    }

    fn note_failure(&self) {
        let count = self.fail_count.fetch_add(1, Ordering::Relaxed) + 1;
        if count >= FAIL_THRESHOLD {
            self.cooldown_until
                .store(now_secs() + COOLDOWN_SECS, Ordering::Relaxed);
            self.fail_count.store(0, Ordering::Relaxed);
            eprintln!("[SCAnon] circuit open — skipping anon for {COOLDOWN_SECS}s");
        }
    }

    /// Fetch the full audio bytes for a track URN.
    /// Returns `Ok(None)` if SC has no usable transcoding (geo-blocked,
    /// preview-only, etc.) so the caller can fall through to the next source.
    /// `Err` is reserved for network failures and feeds the circuit breaker.
    pub async fn get_stream(&self, track_urn: &str) -> Result<Option<AnonStreamResult>, String> {
        if self.in_cooldown() {
            return Ok(None);
        }
        let result = self.do_get_stream(track_urn).await;
        match &result {
            Ok(Some(_)) => self.note_success(),
            Err(_) => self.note_failure(),
            Ok(None) => {}
        }
        result
    }

    async fn do_get_stream(&self, track_urn: &str) -> Result<Option<AnonStreamResult>, String> {
        let track_id = track_urn.rsplit(':').next().unwrap_or(track_urn);

        let track = match self.get_track_by_id(track_id).await {
            Ok(t) => t,
            Err(e) => {
                eprintln!("[SCAnon] get track failed: {e}");
                return Err(e);
            }
        };

        let transcodings = track.media.as_ref().and_then(|m| m.transcodings.as_ref());

        // No transcodings? refresh client_id once and retry the lookup.
        let transcodings_owned;
        let transcodings: &[Transcoding] = match transcodings {
            Some(t) if !t.is_empty() => t.as_slice(),
            _ => {
                eprintln!("[SCAnon] no transcodings for {track_id}, refreshing client_id");
                self.invalidate_and_refresh().await?;
                let retry_track = match self.get_track_by_id(track_id).await {
                    Ok(t) => t,
                    Err(e) => {
                        eprintln!("[SCAnon] retry get track failed: {e}");
                        return Err(e);
                    }
                };
                transcodings_owned = retry_track
                    .media
                    .and_then(|m| m.transcodings)
                    .unwrap_or_default();
                if transcodings_owned.is_empty() {
                    eprintln!("[SCAnon] still no transcodings for {track_id} after refresh");
                    return Ok(None);
                }
                transcodings_owned.as_slice()
            }
        };

        match self.stream_from_transcodings(transcodings).await {
            Ok(Some(r)) => Ok(Some(r)),
            Ok(None) => Ok(None),
            Err(e) => {
                eprintln!("[SCAnon] stream failed for {track_id}, refreshing client_id: {e}");
                self.invalidate_and_refresh().await?;
                let retry_track = match self.get_track_by_id(track_id).await {
                    Ok(t) => t,
                    Err(e2) => {
                        eprintln!("[SCAnon] retry get track failed: {e2}");
                        return Err(e2);
                    }
                };
                let retry_transcodings = retry_track
                    .media
                    .and_then(|m| m.transcodings)
                    .unwrap_or_default();
                if retry_transcodings.is_empty() {
                    return Ok(None);
                }
                self.stream_from_transcodings(&retry_transcodings).await
            }
        }
    }

    async fn stream_from_transcodings(
        &self,
        transcodings: &[Transcoding],
    ) -> Result<Option<AnonStreamResult>, String> {
        let ranked = ranked_transcodings(transcodings);
        if ranked.is_empty() {
            return Ok(None);
        }

        let mut last_err: Option<String> = None;
        for t in ranked {
            let is_progressive = t
                .format
                .as_ref()
                .and_then(|f| f.protocol.as_deref())
                == Some("progressive");

            let media_url = match self.resolve_transcoding_url(&t.url, None).await {
                Ok(u) => u,
                Err(e) => {
                    last_err = Some(format!(
                        "resolve {} failed: {e}",
                        t.preset.as_deref().unwrap_or("?")
                    ));
                    continue;
                }
            };

            let result = if is_progressive {
                download_progressive(&self.client, &media_url).await
            } else {
                download_hls_full(&self.client, &media_url).await
            };

            match result {
                Ok(data) => return Ok(Some(AnonStreamResult { data })),
                Err(e) => {
                    last_err = Some(format!(
                        "{} ({}) failed: {e}",
                        t.preset.as_deref().unwrap_or("?"),
                        if is_progressive { "progressive" } else { "hls" },
                    ));
                }
            }
        }

        Err(last_err.unwrap_or_else(|| "all anon transcodings failed".into()))
    }

    async fn get_client_id(&self) -> Result<String, String> {
        {
            let cached = self.client_id.read().await;
            if let Some(ref id) = *cached {
                return Ok(id.clone());
            }
        }
        self.refresh_client_id().await
    }

    async fn invalidate_and_refresh(&self) -> Result<String, String> {
        {
            let mut cached = self.client_id.write().await;
            *cached = None;
        }
        self.refresh_client_id().await
    }

    async fn refresh_client_id(&self) -> Result<String, String> {
        let html = self
            .client
            .get(SC_BASE_URL)
            .header("User-Agent", SC_USER_AGENT)
            .send()
            .await
            .map_err(|e| format!("fetch sc home: {e}"))?
            .text()
            .await
            .map_err(|e| format!("read sc home body: {e}"))?;

        let client_id = extract_client_id_from_hydration(&html)
            .ok_or_else(|| "Failed to extract SoundCloud client_id from page".to_string())?;

        let mut cached = self.client_id.write().await;
        *cached = Some(client_id.clone());
        println!("[SCAnon] refreshed public client_id");
        Ok(client_id)
    }

    async fn get_track_by_id(&self, track_id: &str) -> Result<ResolvedTrack, String> {
        let client_id = self.get_client_id().await?;
        let target = format!("{SC_API_V2}/tracks/{track_id}?client_id={client_id}");

        match self.fetch_json::<ResolvedTrack>(&target).await {
            Ok(t) => Ok(t),
            Err(_) => {
                let new_id = self.invalidate_and_refresh().await?;
                let retry = format!("{SC_API_V2}/tracks/{track_id}?client_id={new_id}");
                self.fetch_json(&retry).await
            }
        }
    }

    async fn resolve_transcoding_url(
        &self,
        transcoding_url: &str,
        explicit_client_id: Option<&str>,
    ) -> Result<String, String> {
        let client_id = match explicit_client_id {
            Some(id) => id.to_string(),
            None => self.get_client_id().await?,
        };
        let sep = if transcoding_url.contains('?') { "&" } else { "?" };
        let target = format!("{transcoding_url}{sep}client_id={client_id}");

        match self.fetch_json::<TranscodingResolveResponse>(&target).await {
            Ok(r) => Ok(r.url),
            Err(_) if explicit_client_id.is_none() => {
                let new_id = self.invalidate_and_refresh().await?;
                let retry = format!("{transcoding_url}{sep}client_id={new_id}");
                self.fetch_json::<TranscodingResolveResponse>(&retry)
                    .await
                    .map(|r| r.url)
            }
            Err(e) => Err(e),
        }
    }

    async fn fetch_json<T: serde::de::DeserializeOwned>(&self, url: &str) -> Result<T, String> {
        let resp = self
            .client
            .get(url)
            .header("User-Agent", SC_USER_AGENT)
            .send()
            .await
            .map_err(|e| format!("request: {e}"))?;

        let status = resp.status();
        if !status.is_success() {
            return Err(format!("HTTP {status}"));
        }
        resp.json::<T>().await.map_err(|e| format!("decode: {e}"))
    }
}

/// Drop previews/snipped/encrypted, then rank: progressive first, then HLS,
/// each ordered by preset preference.
fn ranked_transcodings(transcodings: &[Transcoding]) -> Vec<&Transcoding> {
    let candidates: Vec<&Transcoding> = transcodings
        .iter()
        .filter(|t| {
            let encrypted = t
                .format
                .as_ref()
                .and_then(|f| f.protocol.as_deref())
                .unwrap_or("")
                .contains("encrypted");
            !encrypted && !t.snipped.unwrap_or(false) && !t.url.contains("/preview")
        })
        .collect();

    if candidates.is_empty() {
        return Vec::new();
    }

    let is_progressive = |t: &&Transcoding| {
        t.format
            .as_ref()
            .and_then(|f| f.protocol.as_deref())
            == Some("progressive")
    };

    let mut ordered: Vec<&Transcoding> = Vec::with_capacity(candidates.len());

    for preset in PRESET_ORDER {
        if let Some(t) = candidates
            .iter()
            .find(|t| is_progressive(t) && t.preset.as_deref() == Some(preset))
        {
            ordered.push(t);
        }
    }
    for t in &candidates {
        if is_progressive(t) && !ordered.iter().any(|o| std::ptr::eq(*o, *t)) {
            ordered.push(t);
        }
    }
    for preset in PRESET_ORDER {
        if let Some(t) = candidates
            .iter()
            .find(|t| !is_progressive(t) && t.preset.as_deref() == Some(preset))
        {
            ordered.push(t);
        }
    }
    for t in &candidates {
        if !ordered.iter().any(|o| std::ptr::eq(*o, *t)) {
            ordered.push(t);
        }
    }
    ordered
}

/// Pull `client_id` out of `window.__sc_hydration` on the SC homepage.
fn extract_client_id_from_hydration(html: &str) -> Option<String> {
    static PATTERN: &str =
        r#""hydratable"\s*:\s*"apiClient"\s*,\s*"data"\s*:\s*\{\s*"id"\s*:\s*"([^"]+)""#;
    let re = regex::Regex::new(PATTERN).ok()?;
    let caps = re.captures(html)?;
    caps.get(1).map(|m| m.as_str().to_string())
}
