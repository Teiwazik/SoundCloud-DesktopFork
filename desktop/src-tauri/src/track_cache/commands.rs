use tauri::State;

use crate::track_cache::state::{LikeCacheEntry, TrackCacheEntry, TrackCacheState};

#[derive(serde::Deserialize)]
pub struct PreloadEntry {
    pub urn: String,
    pub url: Option<String>,
    pub urls: Option<Vec<String>>,
    pub storage_urls: Option<Vec<String>>,
    pub session_id: Option<String>,
}

#[tauri::command]
pub async fn track_ensure_cached(
    urn: String,
    url: Option<String>,
    urls: Option<Vec<String>>,
    storage_urls: Option<Vec<String>>,
    session_id: Option<String>,
    state: State<'_, TrackCacheState>,
) -> Result<TrackCacheEntry, String> {
    let fallback_urls: Vec<String> = match (urls, url) {
        (Some(u), _) if !u.is_empty() => u,
        (_, Some(u)) => vec![u],
        _ => return Err("no stream URL provided".into()),
    };
    let storage_urls = storage_urls.unwrap_or_default();
    state
        .ensure_cached(
            &urn,
            &fallback_urls,
            &storage_urls,
            session_id.as_deref(),
            false,
        )
        .await
}

#[tauri::command]
pub fn track_is_cached(urn: String, state: State<'_, TrackCacheState>) -> bool {
    state.is_cached(&urn)
}

#[tauri::command]
pub fn track_get_cache_path(urn: String, state: State<'_, TrackCacheState>) -> Option<String> {
    state.get_cache_path(&urn)
}

#[tauri::command]
pub fn track_get_cache_info(
    urn: String,
    state: State<'_, TrackCacheState>,
) -> Option<TrackCacheEntry> {
    state.get_cache_entry(&urn)
}

#[tauri::command]
pub async fn track_preload(
    entries: Vec<PreloadEntry>,
    state: State<'_, TrackCacheState>,
) -> Result<(), String> {
    let mut queued = 0u32;
    for entry in entries {
        if state.is_cached(&entry.urn) {
            continue;
        }

        let Some(permit) = state.try_acquire_preload_slot() else {
            continue;
        };

        queued += 1;
        let state = state.inner().clone();
        let urn = entry.urn;
        let fallback_urls: Vec<String> = match (entry.urls, entry.url) {
            (Some(u), _) if !u.is_empty() => u,
            (_, Some(u)) => vec![u],
            _ => continue,
        };
        let storage_urls = entry.storage_urls.unwrap_or_default();
        let session_id = entry.session_id;

        tokio::spawn(async move {
            let _permit = permit;
            println!("[TrackCache] preloading {urn}");
            if let Err(err) = state
                .ensure_cached(
                    &urn,
                    &fallback_urls,
                    &storage_urls,
                    session_id.as_deref(),
                    false,
                )
                .await
            {
                eprintln!("[TrackCache] preload {urn}: {err}");
            }
        });
    }
    if queued > 0 {
        println!("[TrackCache] queued {queued} preloads");
    }
    Ok(())
}

#[tauri::command]
pub fn track_cache_size(state: State<'_, TrackCacheState>) -> u64 {
    state.cache_size()
}

#[tauri::command]
pub fn track_liked_cache_size(state: State<'_, TrackCacheState>) -> u64 {
    state.liked_cache_size()
}

#[tauri::command]
pub fn track_clear_cache(state: State<'_, TrackCacheState>) {
    state.clear_cache();
}

#[tauri::command]
pub fn track_clear_liked_cache(state: State<'_, TrackCacheState>) {
    state.clear_liked_cache();
}

#[tauri::command]
pub fn track_list_cached(state: State<'_, TrackCacheState>) -> Vec<String> {
    state.list_cached_urns()
}

#[tauri::command]
pub fn track_enforce_cache_limit(limit_mb: u64, state: State<'_, TrackCacheState>) {
    state.enforce_limit(limit_mb);
}

#[tauri::command]
pub async fn track_cache_likes(
    entries: Vec<LikeCacheEntry>,
    state: State<'_, TrackCacheState>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tokio::spawn(async move {
        if let Err(err) = state.cache_likes(entries).await {
            eprintln!("[TrackCache] cache_likes error: {err}");
        }
    });
    Ok(())
}

#[tauri::command]
pub fn track_cache_likes_running(state: State<'_, TrackCacheState>) -> bool {
    state.cache_likes_running()
}

#[tauri::command]
pub fn track_cancel_cache_likes(state: State<'_, TrackCacheState>) {
    state.cancel_cache_likes();
}
