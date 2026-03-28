import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Track } from '../stores/player';
import { usePlayerStore } from '../stores/player';
import { useSettingsStore } from '../stores/settings';
import { api } from './api';
import { getCurrentTime, subscribe as subscribeAudioTime } from './audio';
import { getStaticPort } from './constants';
import { isTauriRuntime } from './runtime';

let connected = false;
let lastConnectAttemptAt = 0;
const CONNECT_RETRY_MS = 5000;

let lastUpdateTs = 0;
let updateTimeout: number | null = null;

let lastUrn: string | null = null;
let lastPlaying = false;
let lastElapsed = 0;
let seekSyncTimer: ReturnType<typeof setTimeout> | null = null;

export let currentLyricLine: string | null = null;

let lastHandledRpcUrn: string | null = null;
let lastHandledRpcAt = 0;

const RPC_OPEN_EVENT = 'discord:open-track';
const RPC_OPEN_DEDUP_MS = 900;
let cachedRpcOpenPort: number | null = null;

function artworkToLarge(url: string | null): string | undefined {
  if (!url) return undefined;
  return url.replace(/-[^-./]+(\.[^.]+)$/, '-t500x500$1');
}

async function getListenInAppUrl(track: Track): Promise<string | undefined> {
  if (!cachedRpcOpenPort) {
    cachedRpcOpenPort = getStaticPort();
  }

  if (!cachedRpcOpenPort && isTauriRuntime()) {
    try {
      const [staticPort] = await invoke<[number, number]>('get_server_ports');
      cachedRpcOpenPort = staticPort;
    } catch {
      cachedRpcOpenPort = null;
    }
  }

  if (!cachedRpcOpenPort) return undefined;
  return `http://127.0.0.1:${cachedRpcOpenPort}/rpc/open?urn=${encodeURIComponent(track.urn)}`;
}

function navigateToTrack(urn: string) {
  const targetPath = `/track/${encodeURIComponent(urn)}`;
  if (window.location.pathname === targetPath) return;
  window.history.pushState({}, '', targetPath);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

async function ensureConnected(): Promise<boolean> {
  if (!useSettingsStore.getState().discordRpc) return false;
  if (connected) return true;

  const now = Date.now();
  if (now - lastConnectAttemptAt < CONNECT_RETRY_MS) {
    return false;
  }
  lastConnectAttemptAt = now;

  try {
    connected = await invoke<boolean>('discord_connect');
    return connected;
  } catch {
    return false;
  }
}

function requestDiscordUpdate(track?: Track) {
  const currentTrack = track ?? usePlayerStore.getState().currentTrack;
  if (!currentTrack) return;

  const now = Date.now();
  const diff = now - lastUpdateTs;

  if (updateTimeout) {
    window.clearTimeout(updateTimeout);
    updateTimeout = null;
  }

  const perform = () => {
    lastUpdateTs = Date.now();
    void updatePresence(currentTrack);
  };

  if (diff >= 1200) {
    perform();
  } else {
    updateTimeout = window.setTimeout(perform, 1200 - diff);
  }
}

function schedulePresenceSync(track: Track, delayMs: number) {
  if (seekSyncTimer) clearTimeout(seekSyncTimer);
  seekSyncTimer = setTimeout(() => {
    seekSyncTimer = null;
    lastElapsed = Math.round(getCurrentTime());
    requestDiscordUpdate(track);
  }, delayMs);
}

async function updatePresence(track: Track) {
  if (!(await ensureConnected())) return;

  try {
    const isPlaying = usePlayerStore.getState().isPlaying;
    const { discordRpcMode, discordRpcShowButton, discordRpcButtonMode } =
      useSettingsStore.getState();

    const appOpenUrl = await getListenInAppUrl(track);

    await invoke('discord_set_activity', {
      track: {
        title: track.title,
        artist: track.user.username,
        artwork_url: artworkToLarge(track.artwork_url),
        track_url: track.permalink_url
          ? `${track.permalink_url}`.replace(/\?.*$/, '')
          : undefined,
        duration_secs: Math.round(track.duration / 1000),
        elapsed_secs: Math.round(getCurrentTime()),
        is_playing: isPlaying,
        mode: discordRpcMode,
        show_button: discordRpcShowButton,
        button_mode: discordRpcButtonMode,
        app_url: appOpenUrl,
        lyric_line: currentLyricLine || undefined,
      },
    });
  } catch (e) {
    console.warn('[Discord] Failed to set activity:', e);
    connected = false;
  }
}

async function clearPresence() {
  if (!connected) return;
  try {
    await invoke('discord_clear_activity');
  } catch {
    connected = false;
  }
}

export function updateDiscordLyric(lyric: string | null) {
  if (currentLyricLine === lyric) return;
  currentLyricLine = lyric;

  const currentTrack = usePlayerStore.getState().currentTrack;
  if (!currentTrack || !useSettingsStore.getState().discordRpc) return;
  requestDiscordUpdate(currentTrack);
}

usePlayerStore.subscribe((state) => {
  const { currentTrack, isPlaying } = state;
  const trackChanged = currentTrack?.urn !== lastUrn;
  const playChanged = isPlaying !== lastPlaying;

  if (trackChanged) {
    currentLyricLine = null;
  }

  if (!currentTrack) {
    if (lastPlaying || trackChanged) {
      void clearPresence();
    }
    if (seekSyncTimer) {
      clearTimeout(seekSyncTimer);
      seekSyncTimer = null;
    }
    lastUrn = null;
    lastPlaying = false;
    lastElapsed = 0;
    return;
  }

  if (!useSettingsStore.getState().discordRpc) {
    lastUrn = currentTrack.urn;
    lastPlaying = isPlaying;
    return;
  }

  if (trackChanged || playChanged) {
    lastUrn = currentTrack.urn;
    lastPlaying = isPlaying;
    lastElapsed = Math.round(getCurrentTime());
    requestDiscordUpdate(currentTrack);
  }
});

useSettingsStore.subscribe((state, prev) => {
  const rpcSettingsChanged =
    state.discordRpc !== prev.discordRpc ||
    state.discordRpcMode !== prev.discordRpcMode ||
    state.discordRpcShowButton !== prev.discordRpcShowButton ||
    state.discordRpcButtonMode !== prev.discordRpcButtonMode;

  if (!rpcSettingsChanged) return;

  if (!state.discordRpc) {
    if (seekSyncTimer) {
      clearTimeout(seekSyncTimer);
      seekSyncTimer = null;
    }
    void clearPresence().finally(() => {
      connected = false;
      void invoke('discord_disconnect').catch(() => undefined);
    });
    return;
  }

  const currentTrack = usePlayerStore.getState().currentTrack;
  if (currentTrack) {
    requestDiscordUpdate(currentTrack);
  }
});

async function handleRpcOpenTrack(urnRaw: string) {
  const urn = urnRaw.trim();
  if (!urn) return;

  const now = Date.now();
  if (urn === lastHandledRpcUrn && now - lastHandledRpcAt < RPC_OPEN_DEDUP_MS) {
    return;
  }
  lastHandledRpcUrn = urn;
  lastHandledRpcAt = now;

  navigateToTrack(urn);

  try {
    const track = await api<Track>(`/tracks/${encodeURIComponent(urn)}`, {
      quietHttpErrors: true,
    });
    usePlayerStore.getState().play(track, [track]);
  } catch (error) {
    console.warn('[Discord] Failed to open track from RPC link:', error);
  }
}

if (isTauriRuntime()) {
  const windowWithFlag = window as typeof window & {
    __scdDiscordRpcOpenListenerBound?: boolean;
    __scdRpcOpenTrack?: (urn: string) => void;
  };

  windowWithFlag.__scdRpcOpenTrack = (urn: string) => {
    void handleRpcOpenTrack(urn || '');
  };

  if (!windowWithFlag.__scdDiscordRpcOpenListenerBound) {
    windowWithFlag.__scdDiscordRpcOpenListenerBound = true;
    void listen<string>(RPC_OPEN_EVENT, (event) => {
      void handleRpcOpenTrack(event.payload || '');
    });
  }
}

subscribeAudioTime(() => {
  const { currentTrack, isPlaying } = usePlayerStore.getState();
  if (!currentTrack || !useSettingsStore.getState().discordRpc) return;

  if (!connected) {
    requestDiscordUpdate(currentTrack);
    return;
  }

  if (!isPlaying) return;

  const elapsed = Math.round(getCurrentTime());
  const drift = Math.abs(elapsed - lastElapsed);
  if (drift >= 2) {
    schedulePresenceSync(currentTrack, 180);
  } else {
    lastElapsed = elapsed;
  }
});
