use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use base64::{Engine as _, engine::general_purpose};
use sha2::{Sha256, Digest};
use tauri::{AppHandle, Emitter, Manager};

// ── PKCE helpers ──────────────────────────────────────────────────

fn generate_code_verifier() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    let mut hasher = Sha256::new();
    hasher.update(seed.to_le_bytes());
    hasher.update(b"ytmusic-pkce-verifier-salt-sc-desktop");
    let result = hasher.finalize();
    general_purpose::URL_SAFE_NO_PAD.encode(result)
}

fn pkce_challenge(verifier: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let result = hasher.finalize();
    general_purpose::URL_SAFE_NO_PAD.encode(result)
}

// ── Shared state ──────────────────────────────────────────────────

pub struct YtMusicState {
    pub access_token: Mutex<Option<String>>,
}

impl YtMusicState {
    pub fn new() -> Self {
        Self { access_token: Mutex::new(None) }
    }
}

static CANCEL_FLAG: std::sync::LazyLock<Arc<AtomicBool>> =
    std::sync::LazyLock::new(|| Arc::new(AtomicBool::new(false)));

// ── Progress type ─────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct YtMusicImportProgress {
    pub total: usize,
    pub current: usize,
    pub found: usize,
    pub not_found: usize,
    pub current_track: String,
}

// ── YouTube Data API types ────────────────────────────────────────

#[derive(serde::Deserialize)]
struct YtRatingListResponse {
    items: Option<Vec<YtVideoItem>>,
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
    #[serde(rename = "pageInfo")]
    page_info: Option<YtPageInfo>,
}

#[derive(serde::Deserialize)]
struct YtPageInfo {
    #[serde(rename = "totalResults")]
    total_results: Option<u32>,
}

#[derive(serde::Deserialize)]
struct YtVideoItem {
    snippet: Option<YtSnippet>,
}

#[derive(serde::Deserialize)]
struct YtSnippet {
    title: Option<String>,
    #[serde(rename = "videoOwnerChannelTitle")]
    video_owner_channel_title: Option<String>,
}

#[derive(serde::Deserialize)]
struct GoogleTokenResponse {
    access_token: String,
}

#[derive(serde::Deserialize)]
struct ScSearchResult {
    collection: Vec<ScTrackResult>,
}

#[derive(serde::Deserialize)]
struct ScTrackResult {
    urn: Option<String>,
}

// ── Auth command ──────────────────────────────────────────────────

#[tauri::command]
pub async fn ytmusic_auth_start(
    client_id: String,
    app: AppHandle,
) -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind local server: {}", e))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{}/callback", port);

    let verifier = generate_code_verifier();
    let challenge = pkce_challenge(&verifier);

    // Google OAuth URL with YouTube readonly scope
    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?\
        response_type=code\
        &client_id={client_id}\
        &scope={}\
        &redirect_uri={}\
        &access_type=online\
        &code_challenge_method=S256\
        &code_challenge={challenge}",
        urlencoding::encode("https://www.googleapis.com/auth/youtube.readonly"),
        urlencoding::encode(&redirect_uri),
    );

    tauri_plugin_opener::open_url(&auth_url, None::<&str>)
        .map_err(|e| format!("Failed to open browser: {}", e))?;;

    let (stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 4096];
    stream.readable().await.map_err(|e| e.to_string())?;
    let n = stream.try_read(&mut buf).unwrap_or(0);
    let request = String::from_utf8_lossy(&buf[..n]);

    let code = request
        .lines()
        .next()
        .and_then(|line| {
            let path = line.split_whitespace().nth(1)?;
            let query = path.split('?').nth(1)?;
            query.split('&').find_map(|kv| {
                let mut parts = kv.splitn(2, '=');
                if parts.next()? == "code" { parts.next().map(|v| v.to_string()) } else { None }
            })
        })
        .ok_or("No code in callback")?;

    let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n\
        <html><body style='font-family:sans-serif;text-align:center;padding:60px;background:#0e0e10;color:white'>\
        <h2>✅ Signed in to YouTube Music!</h2>\
        <p>You can close this tab and return to the app.</p>\
        </body></html>";
    stream.try_write(response.as_bytes()).ok();
    drop(stream);

    // Exchange code for token (PKCE — no client_secret needed)
    let client = reqwest::Client::new();
    let token_resp = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", &redirect_uri),
            ("client_id", &client_id),
            ("code_verifier", &verifier),
        ])
        .send()
        .await
        .map_err(|e| format!("Token exchange failed: {}", e))?;

    if !token_resp.status().is_success() {
        let err = token_resp.text().await.unwrap_or_default();
        return Err(format!("Token exchange error: {}", err));
    }

    let token: GoogleTokenResponse = token_resp.json().await.map_err(|e| e.to_string())?;

    {
        let state = app.state::<YtMusicState>();
        *state.access_token.lock().unwrap() = Some(token.access_token);
    }

    app.emit("ytmusic:authed", ()).ok();
    Ok(())
}

#[tauri::command]
pub fn ytmusic_is_authed(app: AppHandle) -> bool {
    app.state::<YtMusicState>().access_token.lock().unwrap().is_some()
}

#[tauri::command]
pub fn ytmusic_logout(app: AppHandle) {
    let state = app.state::<YtMusicState>();
    *state.access_token.lock().unwrap() = None;
    app.emit("ytmusic:logged_out", ()).ok();
}

// ── Import command ────────────────────────────────────────────────

#[tauri::command]
pub async fn ytmusic_import_start(
    backend_url: String,
    session_id: String,
    app: AppHandle,
) -> Result<Vec<String>, String> {
    CANCEL_FLAG.store(false, Ordering::Relaxed);

    let access_token = {
        let state = app.state::<YtMusicState>();
        let guard = state.access_token.lock().unwrap();
        guard.clone()
    }
    .ok_or("Not authenticated with YouTube Music")?;

    let client = reqwest::Client::new();
    let mut all_tracks: Vec<(String, String)> = Vec::new(); // (title, channel)

    // Paginate liked videos from YouTube Data API v3
    let mut page_token: Option<String> = None;
    let mut total_known: Option<usize> = None;

    loop {
        if CANCEL_FLAG.load(Ordering::Relaxed) { break; }

        let mut url = format!(
            "https://www.googleapis.com/youtube/v3/videos?\
            myRating=like&part=snippet&maxResults=50&videoCategoryId=10"
        );
        if let Some(ref pt) = page_token {
            url.push_str(&format!("&pageToken={}", pt));
        }

        let resp = client
            .get(&url)
            .bearer_auth(&access_token)
            .send()
            .await
            .map_err(|e| format!("YouTube API request failed: {}", e))?;

        if resp.status() == 401 {
            {
                let state = app.state::<YtMusicState>();
                *state.access_token.lock().unwrap() = None;
            }
            app.emit("ytmusic:logged_out", ()).ok();
            return Err("YouTube token expired. Please sign in again.".into());
        }

        let page: YtRatingListResponse = resp.json().await.map_err(|e| e.to_string())?;

        if total_known.is_none() {
            if let Some(info) = &page.page_info {
                total_known = info.total_results.map(|t| t as usize);
            }
        }

        for item in page.items.unwrap_or_default() {
            if let Some(snippet) = item.snippet {
                let title = snippet.title.unwrap_or_default();
                let channel = snippet.video_owner_channel_title.unwrap_or_default();
                // Strip " - Topic" suffix from auto-generated artist channels
                let artist = channel.trim_end_matches(" - Topic").to_string();
                if !title.is_empty() {
                    all_tracks.push((title, artist));
                }
            }
        }

        match page.next_page_token {
            Some(pt) => page_token = Some(pt),
            None => break,
        }
    }

    let total = all_tracks.len();
    let mut found = 0usize;
    let mut not_found = 0usize;
    let mut found_urns: Vec<String> = Vec::new();

    for (i, (title, artist)) in all_tracks.iter().enumerate() {
        if CANCEL_FLAG.load(Ordering::Relaxed) { break; }

        let current_track = format!("{} - {}", artist, title);
        app.emit("ytmusic_import:progress", YtMusicImportProgress {
            total,
            current: i + 1,
            found,
            not_found,
            current_track: current_track.clone(),
        }).ok();

        let query = format!("{} {}", artist, title);
        let search_url = format!(
            "{}/tracks?q={}&limit=3&linked_partitioning=true",
            backend_url,
            urlencoding::encode(&query)
        );

        let search_resp = client
            .get(&search_url)
            .header("x-session-id", &session_id)
            .send()
            .await;

        if let Ok(resp) = search_resp {
            if let Ok(results) = resp.json::<ScSearchResult>().await {
                if let Some(urn) = results.collection.first().and_then(|t| t.urn.as_deref()) {
                    found_urns.push(urn.to_string());
                    found += 1;
                } else {
                    not_found += 1;
                }
            } else {
                not_found += 1;
            }
        } else {
            not_found += 1;
        }

        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    }

    app.emit("ytmusic_import:progress", YtMusicImportProgress {
        total,
        current: total,
        found,
        not_found,
        current_track: String::new(),
    }).ok();

    Ok(found_urns)
}

#[tauri::command]
pub fn ytmusic_import_stop() {
    CANCEL_FLAG.store(true, Ordering::Relaxed);
}
