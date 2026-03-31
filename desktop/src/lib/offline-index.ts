import { BaseDirectory, exists, mkdir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import type { Track } from '../stores/player';
import { isTauriRuntime } from './runtime';

const BASE_DIR = BaseDirectory.AppData;
const INDEX_PATH = 'offline-index.json';

interface OfflineIndex {
  likedUrns: string[];
  tracksByUrn: Record<string, Track>;
  updatedAt: number | null;
}

const EMPTY_INDEX: OfflineIndex = {
  likedUrns: [],
  tracksByUrn: {},
  updatedAt: null,
};

let indexCache: OfflineIndex | null = null;
let loadPromise: Promise<OfflineIndex> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let dirReady: Promise<void> | null = null;

function ensureDir() {
  if (!isTauriRuntime()) {
    return Promise.resolve();
  }

  if (!dirReady) {
    dirReady = mkdir('', { baseDir: BASE_DIR, recursive: true }).catch(() => {});
  }

  return dirReady;
}

function cloneTrack(track: Track): Track {
  return {
    ...track,
    user: { ...track.user },
  };
}

async function readIndexFile(): Promise<OfflineIndex> {
  if (!isTauriRuntime()) {
    return EMPTY_INDEX;
  }

  await ensureDir();

  try {
    if (!(await exists(INDEX_PATH, { baseDir: BASE_DIR }))) {
      return EMPTY_INDEX;
    }

    const raw = await readTextFile(INDEX_PATH, { baseDir: BASE_DIR });
    const parsed = JSON.parse(raw) as OfflineIndex;
    return {
      likedUrns: Array.isArray(parsed.likedUrns) ? parsed.likedUrns : [],
      tracksByUrn: parsed.tracksByUrn ?? {},
      updatedAt: parsed.updatedAt ?? null,
    };
  } catch {
    return EMPTY_INDEX;
  }
}

async function loadIndex(): Promise<OfflineIndex> {
  if (indexCache) {
    return indexCache;
  }

  if (!loadPromise) {
    loadPromise = readIndexFile()
      .then((parsed) => {
        indexCache = parsed;
        return parsed;
      })
      .finally(() => {
        loadPromise = null;
      });
  }

  return loadPromise;
}

function schedulePersist() {
  if (persistTimer) {
    clearTimeout(persistTimer);
  }

  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (!indexCache || !isTauriRuntime()) return;

    void ensureDir().then(() =>
      writeTextFile(INDEX_PATH, JSON.stringify(indexCache), { baseDir: BASE_DIR }).catch(() => {}),
    );
  }, 120);
}

export async function rememberTracks(tracks: Track[]) {
  if (tracks.length === 0) return;

  const index = await loadIndex();
  let changed = false;

  for (const track of tracks) {
    if (!track?.urn) continue;
    index.tracksByUrn[track.urn] = cloneTrack(track);
    changed = true;
  }

  if (changed) {
    schedulePersist();
  }
}

export async function rememberLikedTracks(tracks: Track[]) {
  const index = await loadIndex();
  for (const track of tracks) {
    if (!track?.urn) continue;
    index.tracksByUrn[track.urn] = cloneTrack(track);
  }

  index.likedUrns = tracks.map((track) => track.urn);
  index.updatedAt = Date.now();
  schedulePersist();
}

export async function getOfflineLikedTracks() {
  const index = await loadIndex();
  return index.likedUrns
    .map((urn) => index.tracksByUrn[urn])
    .filter((track): track is Track => Boolean(track));
}

export async function getOfflineTracksByUrns(urns: string[]) {
  const index = await loadIndex();
  return urns
    .map((urn) => index.tracksByUrn[urn])
    .filter((track): track is Track => Boolean(track));
}

export async function getOfflineIndexUpdatedAt() {
  const index = await loadIndex();
  return index.updatedAt;
}
