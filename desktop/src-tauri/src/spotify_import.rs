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
    // Use sha256 of seed + a fixed salt as a pseudo-random verifier
    let mut hasher = Sha256::new();
    hasher.update(seed.to_le_bytes());
    hasher.update(b"spotify-pkce-verifier-salt-sc-desktop");
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

pub struct SpotifyState {
    pub access_token: Mutex<Option<String>>,
}

impl SpotifyState {
    pub fn new() -> Self {
        Self { access_token: Mutex::new(None) }
    }
}

static CANCEL_FLAG: std::sync::LazyLock<Arc<AtomicBool>> =
    std::sync::LazyLock::new(|| Arc::new(AtomicBool::new(false)));

// ── Progress type ─────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct SpotifyImportProgress {
    pub total: usize,
    pub current: usize,
    pub found: usize,
    pub not_found: usize,
    pub current_track: String,
}

// ── Spotify API types ─────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct SpotifySavedTracksPage {
    items: Vec<SpotifySavedTrack>,
    next: Option<String>,
    total: u32,
}

#[derive(serde::Deserialize)]
struct SpotifySavedTrack {
    track: Option<SpotifyTrack>,
}

#[derive(serde::Deserialize)]
struct SpotifyTrack {
    name: Option<String>,
    artists: Option<Vec<SpotifyArtist>>,
}

#[derive(serde::Deserialize)]
struct SpotifyArtist {
    name: Option<String>,
}

#[derive(serde::Deserialize)]
struct SpotifyTokenResponse {
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
pub async fn spotify_auth_start(
    client_id: String,
    app: AppHandle,
) -> Result<(), String> {
    // Pick a free TCP port
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind local server: {}", e))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{}/callback", port);

    let verifier = generate_code_verifier();
    let challenge = pkce_challenge(&verifier);

    let auth_url = format!(
        "https://accounts.spotify.com/authorize?\
        response_type=code\
        &client_id={client_id}\
        &scope=user-library-read\
        &redirect_uri={}\
        &code_challenge_method=S256\
        &code_challenge={challenge}",
        urlencoding::encode(&redirect_uri),
    );

    // Open the browser
    tauri_plugin_opener::open_url(&auth_url, None::<&str>)
        .map_err(|e| format!("Failed to open browser: {}", e))?;

    // Accept the redirect
    let (stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 4096];
    stream.readable().await.map_err(|e| e.to_string())?;
    let n = stream.try_read(&mut buf).unwrap_or(0);
    let request = String::from_utf8_lossy(&buf[..n]);

    // Parse ?code= from "GET /callback?code=XXXX HTTP/1.1"
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

    // Send HTML close page
    let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n\
        <html><body style='font-family:sans-serif;text-align:center;padding:60px;background:#0e0e10;color:white'>\
        <h2>✅ Signed in to Spotify!</h2>\
        <p>You can close this tab and return to the app.</p>\
        </body></html>";
    stream.try_write(response.as_bytes()).ok();
    drop(stream);

    // Exchange code for access token (PKCE — no client_secret needed)
    let client = reqwest::Client::new();
    let token_resp = client
        .post("https://accounts.spotify.com/api/token")
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

    let raw = token_resp.text().await.map_err(|e| e.to_string())?;
    let token: SpotifyTokenResponse = serde_json::from_str(&raw)
        .map_err(|e| format!("Token parse error: {} — body: {}", e, &raw[..raw.len().min(300)]))?;

    {
        let state = app.state::<SpotifyState>();
        *state.access_token.lock().unwrap() = Some(token.access_token);
    }

    app.emit("spotify:authed", ()).ok();
    Ok(())
}

#[tauri::command]
pub fn spotify_is_authed(app: AppHandle) -> bool {
    app.state::<SpotifyState>().access_token.lock().unwrap().is_some()
}

#[tauri::command]
pub fn spotify_logout(app: AppHandle) {
    let state = app.state::<SpotifyState>();
    *state.access_token.lock().unwrap() = None;
    app.emit("spotify:logged_out", ()).ok();
}

// ── Import command ────────────────────────────────────────────────

#[tauri::command]
pub async fn spotify_import_start(
    backend_url: String,
    session_id: String,
    app: AppHandle,
) -> Result<Vec<String>, String> {
    CANCEL_FLAG.store(false, Ordering::Relaxed);

    let access_token = {
        let state = app.state::<SpotifyState>();
        let guard = state.access_token.lock().unwrap();
        guard.clone()
    }
    .ok_or("Not authenticated with Spotify")?;

    let client = reqwest::Client::new();
    let mut all_tracks: Vec<(String, String)> = Vec::new(); // (title, artist)

    // Paginate all liked songs
    let mut url = "https://api.spotify.com/v1/me/tracks?limit=50&offset=0".to_string();
    loop {
        if CANCEL_FLAG.load(Ordering::Relaxed) { break; }
        let resp = client
            .get(&url)
            .bearer_auth(&access_token)
            .send()
            .await
            .map_err(|e| format!("Spotify request failed: {}", e))?;

        if resp.status() == 401 {
            {
                let state = app.state::<SpotifyState>();
                *state.access_token.lock().unwrap() = None;
            }
            app.emit("spotify:logged_out", ()).ok();
            return Err("Spotify token expired. Please sign in again.".into());
        }
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Spotify API error {}: {}", status, &body[..body.len().min(300)]));
        }

        let raw = resp.text().await.map_err(|e| e.to_string())?;
        let page: SpotifySavedTracksPage = serde_json::from_str(&raw)
            .map_err(|e| format!("Spotify API parse error: {} — body: {}", e, &raw[..raw.len().min(300)]))?;

        for item in &page.items {
            if let Some(track) = &item.track {
                let title = track.name.as_deref().unwrap_or("").to_string();
                let artist = track
                    .artists
                    .as_ref()
                    .and_then(|a| a.first())
                    .and_then(|a| a.name.as_deref())
                    .unwrap_or("")
                    .to_string();
                if !title.is_empty() {
                    all_tracks.push((title, artist));
                }
            }
        }

        match page.next {
            Some(next) => url = next,
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
        app.emit("spotify_import:progress", SpotifyImportProgress {
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

        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

    app.emit("spotify_import:progress", SpotifyImportProgress {
        total,
        current: total,
        found,
        not_found,
        current_track: String::new(),
    }).ok();

    Ok(found_urns)
}

#[tauri::command]
pub fn spotify_import_stop() {
    CANCEL_FLAG.store(true, Ordering::Relaxed);
}
