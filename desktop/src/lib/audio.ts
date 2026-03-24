import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Track } from '../stores/player';
import { usePlayerStore } from '../stores/player';
import { useSettingsStore } from '../stores/settings';
import { api, getSessionId } from './api';
import { fetchAndCacheTrack, getCacheFilePath, isCached } from './cache';
import { API_BASE } from './constants';
import { art } from './formatters';
import { audioAnalyser } from './audio-analyser';
import { useSoundWaveStore } from '../stores/soundwave';

/* ── Audio engine state ──────────────────────────────────────── */

let currentUrn: string | null = null;
let hasTrack = false;
let fallbackDuration = 0;
let cachedTime = 0;
let cachedDuration = 0;
let loadGen = 0;
let lastTickAt = 0;
let isCrossfadingOut = false;
let crossfadeInProgress = false;
// @ts-expect-error — used for stall detection interval
let stallCheckTimer: ReturnType<typeof setInterval> | null = null; // eslint-disable-line
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getCurrentTime(): number {
  return cachedTime;
}

export function getSmoothCurrentTime(): number {
  if (!usePlayerStore.getState().isPlaying || !hasTrack) return cachedTime;
  const now = Date.now();
  if (lastTickAt === 0 || now < lastTickAt) return cachedTime;
  const elapsed = (now - lastTickAt) / 1000;
  return Math.min(cachedTime + elapsed, cachedTime + 1.0);
}

export function getDuration(): number {
  return cachedDuration;
}

export function seek(seconds: number) {
  if (!hasTrack) return;
  invoke('audio_seek', { position: seconds }).catch(console.error);
  cachedTime = seconds;
  lastTickAt = Date.now();
  notify();
  setTimeout(() => updateMediaPosition(), 150);
}

export function handlePrev() {
  if (getCurrentTime() > 3) {
    seek(0);
  } else {
    usePlayerStore.getState().prev();
  }
}

/* ── Native audio control ────────────────────────────────────── */

function stopTrack() {
  invoke('audio_stop').catch(console.error);
  hasTrack = false;
  cachedTime = 0;
}

/** Reload the current track on new audio device, preserving position */
export async function reloadCurrentTrack() {
  const track = usePlayerStore.getState().currentTrack;
  if (!track) return;
  const wasPlaying = usePlayerStore.getState().isPlaying;
  const pos = cachedTime;
  await loadTrack(track);
  if (pos > 0) seek(pos);
  if (!wasPlaying) invoke('audio_pause').catch(console.error);
}

async function loadTrack(track: Track, skipStop = false) {
  const gen = ++loadGen;
  if (!skipStop) stopTrack();
  currentUrn = track.urn;
  const urn = track.urn;

  fallbackDuration = track.duration / 1000;
  cachedDuration = fallbackDuration;
  cachedTime = 0;
  notify();

  // Sync EQ state to Rust
  const { eqEnabled, eqGains } = useSettingsStore.getState();
  invoke('audio_set_eq', { enabled: eqEnabled, gains: eqGains }).catch(console.error);

  // Sync volume
  invoke('audio_set_volume', { volume: usePlayerStore.getState().volume }).catch(console.error);

  // Try cached file first
  const cachedPath = await getCacheFilePath(urn);
  if (gen !== loadGen) return;
  
  const settings = useSettingsStore.getState();
  const crossfadeSecs = settings.crossfadeEnabled ? settings.crossfadeDuration : null;

  try {
    let result: { duration_secs: number | null };
    if (cachedPath) {
      result = await invoke<{ duration_secs: number | null }>('audio_load_file', {
        path: cachedPath,
        crossfadeSecs
      });
    } else {
      const url = `${API_BASE}/tracks/${encodeURIComponent(urn)}/stream`;
      const sessionId = getSessionId();
      result = await invoke<{ duration_secs: number | null }>('audio_load_url', {
        url,
        sessionId: sessionId || null,
        cachePath: null,
        crossfadeSecs
      });
      // Background cache for next time
      fetchAndCacheTrack(urn).catch(() => {});
    }
    // Detect preview: real audio duration is much shorter than track metadata duration
    if (result.duration_secs != null && fallbackDuration > 0) {
      const ratio = result.duration_secs / fallbackDuration;
      if (ratio < 0.5) {
        usePlayerStore.getState().setCurrentTrackAccess('preview');
      }
    }
  } catch (e) {
    console.error('[Audio] Load failed:', e);
    if (gen !== loadGen) return;
    usePlayerStore.getState().pause();
    return;
  }

  // Stale check — another loadTrack started while we were loading
  if (gen !== loadGen) {
    invoke('audio_stop').catch(console.error);
    return;
  }
  hasTrack = true;

  // Record to listening history (fire-and-forget)
  if (track.urn && track.title) {
    api('/history', {
      method: 'POST',
      body: JSON.stringify({
        scTrackId: track.urn,
        title: track.title,
        artistName: track.user?.username || '',
        artworkUrl: track.artwork_url || null,
        duration: track.duration || 0,
      }),
    }).catch(() => {});
  }

  if (!usePlayerStore.getState().isPlaying) {
    invoke('audio_pause').catch(console.error);
  }

  updatePlaybackState(usePlayerStore.getState().isPlaying);
  updateMediaPosition();
  preloadQueue();
  isCrossfadingOut = false;
}

function handleTrackEnd() {
  const state = usePlayerStore.getState();
  const sw = useSoundWaveStore.getState();

  if (sw.isActive && state.currentTrack) {
    sw.recordFeedback(state.currentTrack, 'positive');
  }

  if (state.repeat === 'one') {
    // rodio sink is empty after track ends — must reload
    if (state.currentTrack) void loadTrack(state.currentTrack);
  } else {
    const { queue, queueIndex } = state;
    const isLast = queueIndex >= queue.length - 1;
    if (isLast && state.repeat === 'off' && queue.length > 0) {
      void autoplayRelated(queue[queueIndex]);
    } else {
      // Clear currentUrn so subscriber detects change even if next track has same URN
      currentUrn = null;
      usePlayerStore.getState().next();
    }
  }
}

/* ── Tauri event listeners ───────────────────────────────────── */

listen<number>('audio:tick', (event) => {
  cachedTime = event.payload;
  lastTickAt = Date.now();
  if (cachedDuration <= 0) cachedDuration = fallbackDuration;
  notify();

  const settings = useSettingsStore.getState();
  if (settings.crossfadeEnabled && cachedDuration > 0) {
    const remaining = cachedDuration - cachedTime;
    if (remaining <= settings.crossfadeDuration && remaining > 0 && !isCrossfadingOut) {
      isCrossfadingOut = true;
      crossfadeInProgress = true;
      handleTrackEnd();
    }
  }
});

listen('audio:ended', () => {
  hasTrack = false;
  handleTrackEnd();
});

listen('audio:device-reconnected', () => {
  console.log('[Audio] Device reconnected (BT profile switch?), reloading track...');
  void reloadCurrentTrack();
});

// Fallback stall detector: if playing but no ticks for 2s, assume device died and reload
const STALL_THRESHOLD_MS = 2000;
const STALL_COOLDOWN_MS = 10000; // after a stall reload, wait 10s before detecting again
let stallCooldownUntil = 0;
let resumeGuardUntil = 0; // suppress stall detection right after visibility resume
stallCheckTimer = setInterval(() => {
  if (!hasTrack || !lastTickAt) return;
  const { isPlaying } = usePlayerStore.getState();
  if (!isPlaying) return;
  const now = Date.now();
  if (now < stallCooldownUntil || now < resumeGuardUntil) return;
  const elapsed = now - lastTickAt;
  if (elapsed > STALL_THRESHOLD_MS) {
    console.log(`[Audio] Stall detected (no ticks for ${elapsed}ms), reloading track...`);
    lastTickAt = now; // prevent re-trigger
    stallCooldownUntil = now + STALL_COOLDOWN_MS;
    void reloadCurrentTrack();
  }
}, 1000);

// On visibility resume after long idle, force device reconnect before playing
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    // Suppress stall detector for 5s after resume to give audio time to warm up
    resumeGuardUntil = Date.now() + 5000;
    // If we had a track and were playing, verify audio is alive
    if (hasTrack && usePlayerStore.getState().isPlaying && lastTickAt > 0) {
      const idle = Date.now() - lastTickAt;
      // If no ticks for >30s, audio device is likely dead — force reconnect
      if (idle > 30000) {
        console.log(
          `[Audio] Resuming after ${Math.round(idle / 1000)}s idle, forcing device reconnect...`,
        );
        invoke('audio_switch_device', { deviceName: null })
          .then(() => {
            console.log('[Audio] Device reconnected after idle, reloading track...');
            void reloadCurrentTrack();
          })
          .catch((e) => {
            console.error('[Audio] Device reconnect failed:', e);
            void reloadCurrentTrack();
          });
      }
    }
  }
});

/* ── Store subscriber ────────────────────────────────────────── */

usePlayerStore.subscribe((state, prev) => {
  const trackChanged = state.currentTrack?.urn !== currentUrn;
  const playToggled = state.isPlaying !== prev.isPlaying;

  if (trackChanged) {
    if (state.currentTrack) {
      updateMetadata(state.currentTrack);
      audioAnalyser.setTrack(state.currentTrack.urn);
      const shouldSkipStop = crossfadeInProgress;
      crossfadeInProgress = false;
      void loadTrack(state.currentTrack, shouldSkipStop);
    } else {
      audioAnalyser.setTrack(null);
      stopTrack();
      currentUrn = null;
      fallbackDuration = 0;
      cachedDuration = 0;
      notify();
    }
    return;
  }

  if (playToggled && !trackChanged) {
    if (state.isPlaying) {
      if (!hasTrack && state.currentTrack) {
        void loadTrack(state.currentTrack);
      } else {
        invoke('audio_play').catch(console.error);
      }
    } else {
      invoke('audio_pause').catch(console.error);
    }
    updatePlaybackState(state.isPlaying);
  }

  if (state.volume !== prev.volume) {
    invoke('audio_set_volume', { volume: state.volume }).catch(console.error);
  }
});

/* ── EQ settings subscriber ──────────────────────────────────── */

useSettingsStore.subscribe((state, prev) => {
  if (state.eqEnabled !== prev.eqEnabled || state.eqGains !== prev.eqGains) {
    invoke('audio_set_eq', { enabled: state.eqEnabled, gains: state.eqGains }).catch(console.error);
  }
});

/* ── Native Media Controls (souvlaki: MPRIS/SMTC) ───────────── */

function updateMetadata(track: Track) {
  const coverUrl = art(track.artwork_url, 't500x500') || undefined;
  invoke('audio_set_metadata', {
    title: track.title,
    artist: track.user.username,
    coverUrl: coverUrl || null,
    durationSecs: track.duration / 1000,
  }).catch(console.error);
}

function updatePlaybackState(playing: boolean) {
  invoke('audio_set_playback_state', { playing }).catch(console.error);
}

function updateMediaPosition() {
  const pos = getCurrentTime();
  if (pos > 0) {
    invoke('audio_set_media_position', { position: pos }).catch(console.error);
  }
}

// Listen for media control events from souvlaki (MPRIS/SMTC)
listen('media:play', () => usePlayerStore.getState().resume());
listen('media:pause', () => usePlayerStore.getState().pause());
listen('media:toggle', () => usePlayerStore.getState().togglePlay());
listen('media:next', () => usePlayerStore.getState().next());
listen('media:prev', () => handlePrev());
listen<number>('media:seek', (e) => seek(e.payload));
listen<number>('media:seek-relative', (e) => {
  const offset = e.payload;
  if (offset > 0) {
    seek(Math.min(getCurrentTime() + offset, getDuration()));
  } else {
    seek(Math.max(getCurrentTime() + offset, 0));
  }
});

/* ── Autoplay ────────────────────────────────────────────────── */

let autoplayLoading = false;

async function autoplayRelated(lastTrack: Track) {
  if (autoplayLoading) return;
  autoplayLoading = true;

  try {
    const { queue } = usePlayerStore.getState();
    const existingUrns = new Set(queue.map((t) => t.urn));
    const res = await api<{ collection: Track[] }>(
      `/tracks/${encodeURIComponent(lastTrack.urn)}/related?limit=20`,
    );
    const fresh = res.collection.filter((t) => !existingUrns.has(t.urn));
    if (fresh.length === 0) {
      usePlayerStore.getState().pause();
      return;
    }

    usePlayerStore.getState().addToQueue(fresh);
    usePlayerStore.getState().next();
  } catch (e) {
    console.error('Autoplay related failed:', e);
    usePlayerStore.getState().pause();
  } finally {
    autoplayLoading = false;
  }
}

/* ── Preloading ──────────────────────────────────────────────── */

let preloadTimer: ReturnType<typeof setTimeout> | null = null;
const MAX_CONCURRENT_PRELOADS = 2;
let activePreloads = 0;

export function preloadTrack(urn: string) {
  if (preloadTimer) clearTimeout(preloadTimer);
  preloadTimer = setTimeout(() => {
    if (activePreloads >= MAX_CONCURRENT_PRELOADS) return;
    isCached(urn).then((hit) => {
      if (!hit && activePreloads < MAX_CONCURRENT_PRELOADS) {
        activePreloads++;
        fetchAndCacheTrack(urn)
          .catch(() => {})
          .finally(() => {
            activePreloads--;
          });
      }
    });
  }, 500);
}

export function preloadQueue() {
  const { queue, queueIndex } = usePlayerStore.getState();
  for (let i = 1; i <= 3; i++) {
    const idx = queueIndex + i;
    if (idx < queue.length) {
      const urn = queue[idx].urn;
      isCached(urn).then((hit) => {
        if (!hit) fetchAndCacheTrack(urn).catch(() => {});
      });
    }
  }
}
