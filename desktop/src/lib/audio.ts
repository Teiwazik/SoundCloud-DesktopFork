import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Track } from '../stores/player';
import { usePlayerStore } from '../stores/player';
import { useSettingsStore } from '../stores/settings';
import { useSoundWaveStore } from '../stores/soundwave';
import { api, getSessionId, streamUrl } from './api';
import { audioAnalyser } from './audio-analyser';
import { fetchAndCacheTrack, getCacheFilePath, getCacheTargetPath, isCached } from './cache';
import { art } from './formatters';
import { isTauriRuntime } from './runtime';

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
let lastSmoothTime = 0;
let stallProbeInFlight = false;
let stallRecoveryInFlight = false;
let stallSuppressedUntil = 0;
let endedGuardUntil = 0;
let deviceChangeCooldownUntil = 0;
let seekTargetTime = -1;
let seekPendingUntil = 0;
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
  if (!usePlayerStore.getState().isPlaying || !hasTrack) {
    lastSmoothTime = cachedTime;
    return cachedTime;
  }
  const now = Date.now();
  if (lastTickAt === 0 || now < lastTickAt) return cachedTime;
  const elapsed = (now - lastTickAt) / 1000;
  const raw = Math.min(cachedTime + elapsed, cachedTime + 1.0);

  if (raw + 0.08 < lastSmoothTime && lastSmoothTime - raw < 1.25) {
    return lastSmoothTime;
  }

  lastSmoothTime = raw;
  return raw;
}

export function getDuration(): number {
  return cachedDuration;
}

function suppressStallDetection(ms: number) {
  stallSuppressedUntil = Math.max(stallSuppressedUntil, Date.now() + ms);
}

function inferCodecFromContentType(contentType: string | null | undefined): string | undefined {
  if (!contentType) return undefined;
  const normalized = contentType.toLowerCase();
  if (normalized.includes('opus')) return 'OPUS';
  if (normalized.includes('ogg')) return 'OGG';
  if (normalized.includes('mpeg') || normalized.includes('mp3')) return 'MP3';
  if (normalized.includes('aac') || normalized.includes('mp4a') || normalized.includes('audio/mp4')) {
    return 'AAC';
  }
  if (normalized.includes('flac')) return 'FLAC';
  return undefined;
}

function inferCodecFromFormat(format: string): string | undefined {
  if (format.includes('opus')) return 'OPUS';
  if (format.includes('aac')) return 'AAC';
  if (format.includes('mp3')) return 'MP3';
  return undefined;
}

export function seek(seconds: number) {
  const track = usePlayerStore.getState().currentTrack;
  if (!track) return;

  const duration = getDuration();
  const maxSeek = duration > 0 ? Math.max(0, duration - 0.15) : Number.POSITIVE_INFINITY;
  const target = Math.max(0, Math.min(seconds, maxSeek));

  endedGuardUntil = Date.now() + 2200;
  seekTargetTime = target;
  seekPendingUntil = Date.now() + 3000;
  suppressStallDetection(3200);
  hasTrack = true;
  if (isTauriRuntime()) {
    invoke('audio_seek', { position: target })
      .then(() => {
        seekPendingUntil = Date.now() + 400;
      })
      .catch(async (error) => {
        console.warn('[Audio] seek failed, trying recover...', error);
        try {
          suppressStallDetection(4200);
          seekPendingUntil = Date.now() + 5000;
          await reloadCurrentTrack();
          await invoke('audio_seek', { position: target });
          seekPendingUntil = Date.now() + 400;
          hasTrack = true;
        } catch (recoveryError) {
          console.error('[Audio] seek recovery failed', recoveryError);
          seekPendingUntil = 0;
        }
      });
  }
  cachedTime = target;
  lastSmoothTime = target;
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
  if (isTauriRuntime()) {
    invoke('audio_stop').catch(console.error);
  }
  hasTrack = false;
  cachedTime = 0;
  lastSmoothTime = 0;
}

/** Reload the current track on new audio device, preserving position */
export async function reloadCurrentTrack() {
  if (!isTauriRuntime()) return;
  const track = usePlayerStore.getState().currentTrack;
  if (!track) return;
  suppressStallDetection(4500);
  const wasPlaying = usePlayerStore.getState().isPlaying;
  // If a seek is pending, use the seek target instead of cachedTime
  // (cachedTime may have been overwritten by stale ticks from the old position)
  const pos = seekPendingUntil > Date.now() && seekTargetTime >= 0 ? seekTargetTime : cachedTime;
  await loadTrack(track);
  if (pos > 0) seek(pos);
  if (!wasPlaying) invoke('audio_pause').catch(console.error);
}

async function loadTrack(track: Track, skipStop = false) {
  suppressStallDetection(4500);
  const gen = ++loadGen;
  if (!skipStop) stopTrack();
  currentUrn = track.urn;
  const urn = track.urn;

  fallbackDuration = track.duration / 1000;
  cachedDuration = fallbackDuration;
  cachedTime = 0;
  lastSmoothTime = 0;
  seekTargetTime = -1;
  seekPendingUntil = 0;
  usePlayerStore.getState().setCurrentTrackStreamQuality(undefined);
  usePlayerStore.getState().setCurrentTrackStreamCodec(undefined);
  notify();

  if (!isTauriRuntime()) {
    hasTrack = false;
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        if (isTauriRuntime() && usePlayerStore.getState().currentTrack?.urn === urn) {
          void loadTrack(track, skipStop);
        }
      }, 300);
    }
    return;
  }

  setupTauriBindings();

  // Sync EQ state to Rust
  const { eqEnabled, eqGains, normalizeVolume } = useSettingsStore.getState();
  invoke('audio_set_eq', { enabled: eqEnabled, gains: eqGains }).catch(console.error);
  invoke('audio_set_normalization', { enabled: normalizeVolume }).catch(console.error);

  // Sync volume
  invoke('audio_set_volume', { volume: usePlayerStore.getState().volume }).catch(console.error);

  // Try cached file first
  const cachedPath = await getCacheFilePath(urn);
  if (gen !== loadGen) return;

  const settings = useSettingsStore.getState();
  const crossfadeSecs = settings.crossfadeEnabled ? settings.crossfadeDuration : null;
  const cacheTargetPath = await getCacheTargetPath(urn);

  const loadFromNetworkWithFallback = async () => {
    type Attempt = { format: string; hq: boolean };
    type AudioLoadInvokeResult = {
      duration_secs: number | null;
      stream_quality?: string | null;
      stream_content_type?: string | null;
      stream_codec?: string | null;
    };

    const preferHq = useSettingsStore.getState().highQualityStreaming;
    const attempts: Attempt[] = preferHq
      ? [
          { format: 'hls_aac_160', hq: true },
          { format: 'http_mp3_128', hq: false },
          { format: 'hls_mp3_128', hq: false },
          { format: 'hls_opus_64', hq: false },
        ]
      : [
          { format: 'http_mp3_128', hq: false },
          { format: 'hls_mp3_128', hq: false },
          { format: 'hls_aac_160', hq: true },
          { format: 'hls_opus_64', hq: false },
        ];

    let lastError: unknown = null;
    for (const attempt of attempts) {
      const qualityLabel = attempt.hq ? 'hq' : 'lq';
      const url = streamUrl(urn, attempt.format, attempt.hq);
      console.log(`[Audio] Stream attempt: quality=${qualityLabel}, format=${attempt.format}`);
      try {
        const result = await invoke<AudioLoadInvokeResult>('audio_load_url', {
          url,
          sessionId: getSessionId(),
          cachePath: cacheTargetPath,
          cacheKey: urn,
          crossfadeSecs,
        });
        const streamCodec =
          inferCodecFromContentType(result.stream_content_type) ||
          inferCodecFromFormat(attempt.format) ||
          undefined;
        console.log(
          `[Audio] Stream loaded: requested=${attempt.format}, pref=${qualityLabel}, resolved=${result.stream_quality || 'unknown'}, codec=${streamCodec || 'unknown'}, mime=${result.stream_content_type || 'unknown'}`,
        );
        return { ...result, stream_codec: streamCodec };
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[Audio] Stream attempt failed: quality=${qualityLabel}, format=${attempt.format}, error=${message}`,
        );
      }
    }

    throw lastError || new Error('All stream attempts failed');
  };

  try {
    let result: {
      duration_secs: number | null;
      stream_quality?: string | null;
      stream_content_type?: string | null;
      stream_codec?: string | null;
    };
    let loadedFromCache = false;

    if (cachedPath) {
      try {
        result = await invoke<{
          duration_secs: number | null;
          stream_quality?: string | null;
          stream_content_type?: string | null;
          stream_codec?: string | null;
        }>('audio_load_file', {
          path: cachedPath,
          cacheKey: urn,
          crossfadeSecs,
        });
        loadedFromCache = true;
      } catch (cacheError) {
        console.warn('[Audio] Cached file failed to decode, retrying from network...', cacheError);
        result = await loadFromNetworkWithFallback();
      }
    } else {
      result = await loadFromNetworkWithFallback();
    }

    const resolvedQuality =
      result.stream_quality === 'hq' || result.stream_quality === 'lq'
        ? result.stream_quality
        : loadedFromCache
          ? track.streamQuality || (useSettingsStore.getState().highQualityStreaming ? 'hq' : 'lq')
          : useSettingsStore.getState().highQualityStreaming
            ? 'hq'
            : 'lq';
    const resolvedCodec =
      result.stream_codec ||
      inferCodecFromContentType(result.stream_content_type) ||
      track.streamCodec ||
      (resolvedQuality === 'hq' ? 'AAC' : 'MP3');
    usePlayerStore.getState().setCurrentTrackStreamQuality(resolvedQuality);
    usePlayerStore.getState().setCurrentTrackStreamCodec(resolvedCodec);
    console.log(
      `[Audio] Active stream: quality=${resolvedQuality}, codec=${resolvedCodec || 'unknown'}, source=${loadedFromCache ? 'cache' : 'network'}, mime=${result.stream_content_type || 'unknown'}`,
    );

    // Detect preview: real audio duration is much shorter than track metadata duration
    if (result.duration_secs != null && fallbackDuration > 0) {
      const ratio = result.duration_secs / fallbackDuration;
      if (ratio < 0.5) {
        usePlayerStore.getState().setCurrentTrackAccess('preview');
        usePlayerStore.getState().setCurrentTrackStreamQuality('lq');
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
    if (isTauriRuntime()) {
      invoke('audio_stop').catch(console.error);
    }
    return;
  }
  hasTrack = true;
  lastTickAt = Date.now();

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
    if (isTauriRuntime()) {
      invoke('audio_pause').catch(console.error);
    }
  }

  updatePlaybackState(usePlayerStore.getState().isPlaying);
  updateMediaPosition();
  preloadQueue();
  isCrossfadingOut = false;
}

function handleTrackEnd() {
  const state = usePlayerStore.getState();
  const sw = useSoundWaveStore.getState();

  if (state.currentTrack) {
    audioAnalyser.finalizeCurrentTrackIfReady();
    sw.ingestPlayedTrackFeatures(state.currentTrack);
  }

  if (sw.isActive && !sw.isSuspended && state.currentTrack) {
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
// Fallback stall detector: if playing but no ticks for a while, probe native position first.
const STALL_THRESHOLD_MS = 2400;
const STALL_COOLDOWN_MS = 10000; // after a stall reload, wait 10s before detecting again
const STALL_NATIVE_RESYNC_EPSILON_SEC = 0.35;
let stallCooldownUntil = 0;
let resumeGuardUntil = 0; // suppress stall detection right after visibility resume
let tauriBindingsReady = false;
let tauriBindingsPoll: ReturnType<typeof setInterval> | null = null;

async function recoverFromStall(elapsedMs: number) {
  if (stallProbeInFlight || stallRecoveryInFlight) return;

  stallProbeInFlight = true;
  try {
    const nativePos = await invoke<number>('audio_get_position');
    const now = Date.now();
    const duration = getDuration();
    const clampedNativePos =
      Number.isFinite(nativePos) && nativePos >= 0
        ? duration > 0
          ? Math.min(nativePos, duration)
          : nativePos
        : cachedTime;

    if (clampedNativePos > cachedTime + STALL_NATIVE_RESYNC_EPSILON_SEC) {
      cachedTime = clampedNativePos;
      lastSmoothTime = clampedNativePos;
      lastTickAt = now;
      notify();
      return;
    }

    if (now < stallCooldownUntil || now < resumeGuardUntil || now < stallSuppressedUntil) return;
    if (!hasTrack || !usePlayerStore.getState().isPlaying) return;

    console.log(`[Audio] Stall detected (no ticks for ${elapsedMs}ms), reloading track...`);
    lastTickAt = now;
    stallCooldownUntil = now + STALL_COOLDOWN_MS;
    stallRecoveryInFlight = true;
    suppressStallDetection(5000);
    await reloadCurrentTrack();
  } catch (error) {
    const now = Date.now();
    if (now >= stallCooldownUntil && now >= resumeGuardUntil && now >= stallSuppressedUntil) {
      console.warn('[Audio] Stall probe failed, using reload fallback', error);
      lastTickAt = now;
      stallCooldownUntil = now + STALL_COOLDOWN_MS;
      stallRecoveryInFlight = true;
      suppressStallDetection(5000);
      await reloadCurrentTrack();
    }
  } finally {
    stallRecoveryInFlight = false;
    stallProbeInFlight = false;
  }
}

function setupTauriBindings() {
  if (tauriBindingsReady || !isTauriRuntime()) return;
  tauriBindingsReady = true;

  listen<number>('audio:tick', (event) => {
    const tickPos = event.payload;

    // Reject stale ticks from old position while seek is in progress
    if (seekPendingUntil > Date.now() && seekTargetTime >= 0) {
      const drift = Math.abs(tickPos - seekTargetTime);
      if (drift > 2.0) {
        // Stale tick from pre-seek position — ignore it
        return;
      }
      // Tick is close to target — seek has landed, clear the guard
      seekPendingUntil = 0;
      seekTargetTime = -1;
    }

    cachedTime = tickPos;
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
    const nearTrackEnd =
      cachedDuration > 0 && cachedTime >= Math.max(0, cachedDuration - 1.2);
    if (Date.now() < endedGuardUntil && !nearTrackEnd) {
      console.warn('[Audio] Ignoring spurious ended event during seek transition');
      return;
    }
    hasTrack = false;
    handleTrackEnd();
  });

  listen('audio:device-reconnected', () => {
    console.log('[Audio] Device reconnected (BT profile switch?), reloading track...');
    void reloadCurrentTrack();
  });

  if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      if (!hasTrack || !usePlayerStore.getState().isPlaying) return;

      const now = Date.now();
      if (now < deviceChangeCooldownUntil) return;
      deviceChangeCooldownUntil = now + 3000;

      console.log('[Audio] Media devices changed, re-binding output...');
      invoke('audio_switch_device', { deviceName: null })
        .then(() => {
          void reloadCurrentTrack();
        })
        .catch(() => {
          void reloadCurrentTrack();
        });
    });
  }

  setInterval(() => {
    if (!isTauriRuntime() || !hasTrack || !lastTickAt) return;
    const { isPlaying } = usePlayerStore.getState();
    if (!isPlaying) return;
    const now = Date.now();
    if (now < stallCooldownUntil || now < resumeGuardUntil || now < stallSuppressedUntil) return;
    const elapsed = now - lastTickAt;
    if (elapsed > STALL_THRESHOLD_MS) {
      void recoverFromStall(elapsed);
    }
  }, 1000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      resumeGuardUntil = Date.now() + 5000;
      if (hasTrack && usePlayerStore.getState().isPlaying && lastTickAt > 0) {
        const idle = Date.now() - lastTickAt;
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
}

setupTauriBindings();
if (!tauriBindingsReady) {
  tauriBindingsPoll = setInterval(() => {
    setupTauriBindings();
    if (tauriBindingsReady && tauriBindingsPoll) {
      clearInterval(tauriBindingsPoll);
      tauriBindingsPoll = null;
    }
  }, 300);
}

/* ── Store subscriber ────────────────────────────────────────── */

usePlayerStore.subscribe((state, prev) => {
  const trackChanged = state.currentTrack?.urn !== currentUrn;
  const playToggled = state.isPlaying !== prev.isPlaying;
  const previousTrack = prev.currentTrack;

  if (trackChanged) {
    if (state.currentTrack) {
      const sw = useSoundWaveStore.getState();
      if (sw.isActive && !sw.isSuspended && prev.queueSource === 'soundwave') {
        const switchedToExternalQueue = state.queueSource !== 'soundwave';
        if (switchedToExternalQueue) {
          sw.suspendForExternalPlayback(prev.queue, prev.queueIndex);
        }
      }
    }

    if (state.currentTrack) {
      updateMetadata(state.currentTrack);
      audioAnalyser.setTrack(state.currentTrack.urn);
      if (previousTrack && previousTrack.urn !== state.currentTrack.urn) {
        useSoundWaveStore.getState().ingestPlayedTrackFeatures(previousTrack);
      }
      const shouldSkipStop = crossfadeInProgress;
      crossfadeInProgress = false;
      void loadTrack(state.currentTrack, shouldSkipStop);
    } else {
      audioAnalyser.setTrack(null);
      if (previousTrack) {
        useSoundWaveStore.getState().ingestPlayedTrackFeatures(previousTrack);
      }
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
        if (isTauriRuntime()) {
          invoke('audio_play').catch(console.error);
        }
      }
    } else {
      if (isTauriRuntime()) {
        invoke('audio_pause').catch(console.error);
      }
    }
    updatePlaybackState(state.isPlaying);
  }

  if (isTauriRuntime() && state.volume !== prev.volume) {
    invoke('audio_set_volume', { volume: state.volume }).catch(console.error);
  }
});

/* ── EQ settings subscriber ──────────────────────────────────── */

useSettingsStore.subscribe((state, prev) => {
  if (!isTauriRuntime()) return;
  if (state.eqEnabled !== prev.eqEnabled || state.eqGains !== prev.eqGains) {
    invoke('audio_set_eq', { enabled: state.eqEnabled, gains: state.eqGains }).catch(console.error);
  }
  if (state.normalizeVolume !== prev.normalizeVolume) {
    invoke('audio_set_normalization', { enabled: state.normalizeVolume }).catch(console.error);
  }
});

/* ── Native Media Controls (souvlaki: MPRIS/SMTC) ───────────── */

function updateMetadata(track: Track) {
  if (!isTauriRuntime()) return;
  const coverUrl = art(track.artwork_url, 't500x500') || undefined;
  invoke('audio_set_metadata', {
    title: track.title,
    artist: track.user.username,
    coverUrl: coverUrl || null,
    durationSecs: track.duration / 1000,
  }).catch(console.error);
}

function updatePlaybackState(playing: boolean) {
  if (!isTauriRuntime()) return;
  invoke('audio_set_playback_state', { playing }).catch(console.error);
}

function updateMediaPosition() {
  if (!isTauriRuntime()) return;
  const pos = getCurrentTime();
  if (pos > 0) {
    invoke('audio_set_media_position', { position: pos }).catch(console.error);
  }
}

// Listen for media control events from souvlaki (MPRIS/SMTC)

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
const MAX_CONCURRENT_PRELOADS = 1;
const PRELOAD_LOOKAHEAD_TRACKS = 3;
let activePreloads = 0;
const preloadPendingUrns: string[] = [];
const preloadPendingSet = new Set<string>();
const preloadInFlightSet = new Set<string>();

function queuePreload(urn: string) {
  if (!urn || urn === currentUrn) return;
  if (preloadPendingSet.has(urn) || preloadInFlightSet.has(urn)) return;
  preloadPendingSet.add(urn);
  preloadPendingUrns.push(urn);
}

function schedulePreloadPump(delayMs = 260) {
  if (preloadTimer) clearTimeout(preloadTimer);
  preloadTimer = setTimeout(() => {
    preloadTimer = null;
    void pumpPreloads();
  }, delayMs);
}

async function pumpPreloads() {
  if (!isTauriRuntime()) return;

  while (activePreloads < MAX_CONCURRENT_PRELOADS && preloadPendingUrns.length > 0) {
    const urn = preloadPendingUrns.shift();
    if (!urn) break;
    preloadPendingSet.delete(urn);

    if (urn === currentUrn || preloadInFlightSet.has(urn)) {
      continue;
    }

    preloadInFlightSet.add(urn);
    activePreloads++;

    void isCached(urn)
      .then((hit) => {
        if (!hit) {
          return fetchAndCacheTrack(urn);
        }
        return undefined;
      })
      .catch(() => {})
      .finally(() => {
        activePreloads = Math.max(0, activePreloads - 1);
        preloadInFlightSet.delete(urn);
        if (preloadPendingUrns.length > 0) {
          schedulePreloadPump(220);
        }
      });
  }
}

export function preloadTrack(urn: string) {
  if (!isTauriRuntime()) return;
  queuePreload(urn);
  schedulePreloadPump(500);
}

export function preloadQueue() {
  if (!isTauriRuntime()) return;
  const { queue, queueIndex } = usePlayerStore.getState();
  for (let i = 1; i <= PRELOAD_LOOKAHEAD_TRACKS; i++) {
    const idx = queueIndex + i;
    if (idx < queue.length) {
      queuePreload(queue[idx].urn);
    }
  }
  schedulePreloadPump(420);
}
