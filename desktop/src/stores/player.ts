import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { tauriStorage } from '../lib/tauri-storage';
import { useDislikesStore } from './dislikes';

export const PLAYBACK_RATE_MIN = 0.5;
export const PLAYBACK_RATE_MAX = 2.0;
export const PLAYBACK_RATE_STEP = 0.05;
export const PITCH_SEMITONES_MIN = -12;
export const PITCH_SEMITONES_MAX = 12;
export const PITCH_SEMITONES_STEP = 0.5;
export type PitchControlMode = 'auto' | 'manual';

export function clampPlaybackRate(value: number): number {
  const clamped = Math.max(PLAYBACK_RATE_MIN, Math.min(PLAYBACK_RATE_MAX, value));
  return Math.round(clamped * 100) / 100;
}

export function clampPitchSemitones(value: number): number {
  const clamped = Math.max(PITCH_SEMITONES_MIN, Math.min(PITCH_SEMITONES_MAX, value));
  const snapped = Math.round(clamped / PITCH_SEMITONES_STEP) * PITCH_SEMITONES_STEP;
  return Math.round(snapped * 10) / 10;
}

export function getAutoPitchSemitones(playbackRate: number): number {
  const safeRate = clampPlaybackRate(playbackRate);
  const semitones = 12 * Math.log2(safeRate);
  const clamped = Math.max(PITCH_SEMITONES_MIN, Math.min(PITCH_SEMITONES_MAX, semitones));
  return Math.round(clamped * 10) / 10;
}

export function getEffectivePitchSemitones(
  playbackRate: number,
  pitchControlMode: PitchControlMode,
  pitchSemitones: number,
): number {
  return pitchControlMode === 'auto'
    ? getAutoPitchSemitones(playbackRate)
    : clampPitchSemitones(pitchSemitones);
}

export interface Track {
  id: number;
  urn: string;
  title: string;
  duration: number;
  artwork_url: string | null;
  permalink_url?: string;
  waveform_url?: string;
  genre?: string;
  tag_list?: string;
  description?: string;
  created_at?: string;
  comment_count?: number;
  playback_count?: number;
  likes_count?: number;
  favoritings_count?: number;
  reposts_count?: number;
  user_favorite?: boolean;
  bpm?: number;
  access?: 'playable' | 'preview' | 'blocked';
  streamQuality?: 'hq' | 'lq';
  streamCodec?: string;
  user: {
    id: number;
    urn: string;
    username: string;
    avatar_url: string;
    permalink_url: string;
    followers_count?: number;
  };
}

type RepeatMode = 'off' | 'one' | 'all';
type TrackPlaybackRateMap = Record<string, number>;
type TrackPlaybackRateEnabledMap = Record<string, boolean>;

type PlaybackRateControlState = {
  currentTrack: Track | null;
  playbackRate: number;
  globalPlaybackRate: number;
  trackPlaybackRatesByUrn: TrackPlaybackRateMap;
  trackPlaybackRateEnabledByUrn: TrackPlaybackRateEnabledMap;
};

function sanitizeTrackPlaybackRates(value: unknown): TrackPlaybackRateMap {
  if (!value || typeof value !== 'object') return {};

  const next: TrackPlaybackRateMap = {};
  for (const [urn, rate] of Object.entries(value as Record<string, unknown>)) {
    if (!urn || typeof rate !== 'number' || !Number.isFinite(rate)) continue;
    next[urn] = clampPlaybackRate(rate);
  }

  return next;
}

function sanitizeTrackPlaybackRateEnabledMap(value: unknown): TrackPlaybackRateEnabledMap {
  if (!value || typeof value !== 'object') return {};

  const next: TrackPlaybackRateEnabledMap = {};
  for (const [urn, enabled] of Object.entries(value as Record<string, unknown>)) {
    if (!urn || enabled !== true) continue;
    next[urn] = true;
  }

  return next;
}

function removeTrackPlaybackRateKey<T extends Record<string, unknown>>(map: T, urn: string): T {
  if (!(urn in map)) return map;
  const next = { ...map };
  delete next[urn];
  return next;
}

export function isTrackPlaybackRateEnabledForTrack(
  track: Track | null | undefined,
  trackPlaybackRateEnabledByUrn: TrackPlaybackRateEnabledMap,
): boolean {
  return Boolean(track?.urn && trackPlaybackRateEnabledByUrn[track.urn]);
}

function resolvePlaybackRateForTrack(
  track: Track | null | undefined,
  globalPlaybackRate: number,
  trackPlaybackRateEnabledByUrn: TrackPlaybackRateEnabledMap,
  trackPlaybackRatesByUrn: TrackPlaybackRateMap,
): number {
  const fallbackRate = clampPlaybackRate(globalPlaybackRate);
  if (!track?.urn || !trackPlaybackRateEnabledByUrn[track.urn]) {
    return fallbackRate;
  }

  return clampPlaybackRate(trackPlaybackRatesByUrn[track.urn] ?? fallbackRate);
}

function buildPlaybackRateUpdate(
  state: PlaybackRateControlState,
  nextRate: number,
): {
  playbackRate: number;
  globalPlaybackRate?: number;
  trackPlaybackRatesByUrn?: TrackPlaybackRateMap;
} {
  const playbackRate = clampPlaybackRate(nextRate);
  const urn = state.currentTrack?.urn;

  if (urn && state.trackPlaybackRateEnabledByUrn[urn]) {
    const trackPlaybackRatesByUrn =
      state.trackPlaybackRatesByUrn[urn] === playbackRate
        ? state.trackPlaybackRatesByUrn
        : {
            ...state.trackPlaybackRatesByUrn,
            [urn]: playbackRate,
          };

    return {
      playbackRate,
      trackPlaybackRatesByUrn,
    };
  }

  return {
    playbackRate,
    globalPlaybackRate: playbackRate,
  };
}

function shuffleArray<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function dedupeTracks(tracks: Track[]): Track[] {
  const seen = new Set<string>();
  const unique: Track[] = [];

  for (const track of tracks) {
    if (!track?.urn || seen.has(track.urn)) continue;
    seen.add(track.urn);
    unique.push(track);
  }

  return unique;
}

function appendUniqueTracks(existing: Track[], incoming: Track[]): Track[] {
  if (incoming.length === 0) return existing;

  const seen = new Set(existing.map((track) => track.urn));
  const fresh = incoming.filter((track) => track?.urn && !seen.has(track.urn));

  return fresh.length > 0 ? [...existing, ...fresh] : existing;
}

function insertUniqueTracks(existing: Track[], incoming: Track[], insertIndex: number): Track[] {
  if (incoming.length === 0) return existing;

  const seen = new Set(existing.map((track) => track.urn));
  const fresh = incoming.filter((track) => track?.urn && !seen.has(track.urn));
  if (fresh.length === 0) return existing;

  const queue = [...existing];
  queue.splice(insertIndex, 0, ...fresh);
  return queue;
}

interface PlayerState {
  currentTrack: Track | null;
  queue: Track[];
  originalQueue: Track[] | null;
  queueIndex: number;
  queueSource: 'manual' | 'soundwave';
  isPlaying: boolean;
  volume: number;
  volumeBeforeMute: number;
  playbackRate: number;
  globalPlaybackRate: number;
  trackPlaybackRatesByUrn: TrackPlaybackRateMap;
  trackPlaybackRateEnabledByUrn: TrackPlaybackRateEnabledMap;
  pitchSemitones: number;
  pitchControlMode: PitchControlMode;
  shuffle: boolean;
  repeat: RepeatMode;
  downloadProgress: number | null;

  play: (track: Track, queue?: Track[], source?: 'manual' | 'soundwave') => void;
  playFromQueue: (index: number) => void;
  pause: () => void;
  resume: () => void;
  togglePlay: () => void;
  next: () => void;
  prev: () => void;
  setVolume: (v: number) => void;
  setPlaybackRate: (rate: number) => void;
  resetPlaybackRate: () => void;
  setCurrentTrackPlaybackRateEnabled: (enabled: boolean) => void;
  setPitchSemitones: (value: number) => void;
  resetPitchSemitones: () => void;
  setPitchControlMode: (mode: PitchControlMode) => void;
  setQueue: (queue: Track[]) => void;
  addToQueue: (tracks: Track[]) => void;
  addToQueueNext: (tracks: Track[]) => void;
  removeFromQueue: (index: number) => void;
  moveInQueue: (from: number, to: number) => void;
  clearQueue: () => void;
  toggleShuffle: () => void;
  toggleRepeat: () => void;
  setCurrentTrackAccess: (access: Track['access']) => void;
  setTrackAccessByUrn: (urn: string, access: Track['access']) => void;
  setCurrentTrackStreamQuality: (quality: Track['streamQuality']) => void;
  setCurrentTrackStreamCodec: (codec: Track['streamCodec']) => void;
  replaceTrackMetadata: (track: Track) => void;
}

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set, get) => ({
      currentTrack: null,
      queue: [],
      originalQueue: null,
      queueIndex: -1,
      queueSource: 'manual',
      isPlaying: false,
      volume: 50,
      volumeBeforeMute: 50,
      playbackRate: 1,
      globalPlaybackRate: 1,
      trackPlaybackRatesByUrn: {},
      trackPlaybackRateEnabledByUrn: {},
      pitchSemitones: 0,
      pitchControlMode: 'manual',
      shuffle: false,
      repeat: 'off',
      downloadProgress: null,

      play: (track, queue, source = 'manual') => {
        const {
          shuffle,
          globalPlaybackRate,
          trackPlaybackRatesByUrn,
          trackPlaybackRateEnabledByUrn,
        } = get();
        const playbackRate = resolvePlaybackRateForTrack(
          track,
          globalPlaybackRate,
          trackPlaybackRateEnabledByUrn,
          trackPlaybackRatesByUrn,
        );

        if (queue) {
          const uniqueQueue = dedupeTracks(queue);
          const idx = uniqueQueue.findIndex((t) => t.urn === track.urn);
          const realIdx = idx >= 0 ? idx : 0;

          if (shuffle) {
            const original = [...uniqueQueue];
            const rest = [...uniqueQueue.slice(0, realIdx), ...uniqueQueue.slice(realIdx + 1)];
            shuffleArray(rest);
            set({
              currentTrack: track,
              queue: [track, ...rest],
              queueIndex: 0,
              queueSource: source,
              isPlaying: true,
              playbackRate,
              originalQueue: original,
            });
          } else {
            set({
              currentTrack: track,
              queue: uniqueQueue,
              queueIndex: realIdx,
              queueSource: source,
              isPlaying: true,
              playbackRate,
              originalQueue: null,
            });
          }
        } else {
          const { queue: currentQueue } = get();
          set({
            currentTrack: track,
            queue: [...currentQueue, track],
            queueIndex: currentQueue.length,
            queueSource: source,
            isPlaying: true,
            playbackRate,
          });
        }
      },

      playFromQueue: (index) => {
        const {
          queue,
          globalPlaybackRate,
          trackPlaybackRatesByUrn,
          trackPlaybackRateEnabledByUrn,
        } = get();
        if (index < 0 || index >= queue.length) return;
        const nextTrack = queue[index];
        set({
          currentTrack: nextTrack,
          queueIndex: index,
          isPlaying: true,
          playbackRate: resolvePlaybackRateForTrack(
            nextTrack,
            globalPlaybackRate,
            trackPlaybackRateEnabledByUrn,
            trackPlaybackRatesByUrn,
          ),
        });
      },

      pause: () => set({ isPlaying: false }),
      resume: () => set({ isPlaying: true }),

      togglePlay: () => {
        const { isPlaying, currentTrack } = get();
        if (currentTrack) set({ isPlaying: !isPlaying });
      },

      next: () => {
        const {
          queue,
          queueIndex,
          repeat,
          globalPlaybackRate,
          trackPlaybackRatesByUrn,
          trackPlaybackRateEnabledByUrn,
        } = get();
        if (queue.length === 0) return;

        let nextIdx = queueIndex + 1;
        let attempts = 0;

        while (attempts < queue.length) {
          if (nextIdx >= queue.length) {
            if (repeat === 'all') nextIdx = 0;
            else {
              set({ isPlaying: false });
              return;
            }
          }

          const track = queue[nextIdx];
          const isDisliked = useDislikesStore.getState().dislikedTrackUrns.includes(track.urn);
          const isBlocked = (track.access || 'playable') === 'blocked';
          if (!isDisliked && !isBlocked) break;

          nextIdx++;
          attempts++;
        }

        if (attempts >= queue.length) {
          set({ isPlaying: false });
          return;
        }

        const nextTrack = queue[nextIdx];
        set({
          currentTrack: nextTrack,
          queueIndex: nextIdx,
          isPlaying: true,
          playbackRate: resolvePlaybackRateForTrack(
            nextTrack,
            globalPlaybackRate,
            trackPlaybackRateEnabledByUrn,
            trackPlaybackRatesByUrn,
          ),
        });
      },

      prev: () => {
        const {
          queue,
          queueIndex,
          globalPlaybackRate,
          trackPlaybackRatesByUrn,
          trackPlaybackRateEnabledByUrn,
        } = get();
        if (queue.length === 0) return;

        let prevIdx = queueIndex - 1;
        let attempts = 0;

        while (attempts < queue.length && prevIdx > 0) {
          const track = queue[prevIdx];
          const isDisliked = useDislikesStore.getState().dislikedTrackUrns.includes(track.urn);
          const isBlocked = (track.access || 'playable') === 'blocked';
          if (!isDisliked && !isBlocked) break;

          prevIdx--;
          attempts++;
        }

        prevIdx = Math.max(0, prevIdx);
        const prevTrack = queue[prevIdx];

        set({
          currentTrack: prevTrack,
          queueIndex: prevIdx,
          isPlaying: true,
          playbackRate: resolvePlaybackRateForTrack(
            prevTrack,
            globalPlaybackRate,
            trackPlaybackRateEnabledByUrn,
            trackPlaybackRatesByUrn,
          ),
        });
      },

      setVolume: (v) => {
        const clamped = Math.round(Math.max(0, Math.min(200, v)));
        const prev = get().volume;
        set({
          volume: clamped,
          ...(clamped === 0 && prev > 0 ? { volumeBeforeMute: prev } : {}),
        });
      },

      setPlaybackRate: (rate) => set((state) => buildPlaybackRateUpdate(state, rate)),
      resetPlaybackRate: () => set((state) => buildPlaybackRateUpdate(state, 1)),
      setCurrentTrackPlaybackRateEnabled: (enabled) =>
        set((state) => {
          const track = state.currentTrack;
          if (!track?.urn) return {};

          const urn = track.urn;
          const currentlyEnabled = Boolean(state.trackPlaybackRateEnabledByUrn[urn]);
          if (enabled === currentlyEnabled) return {};

          if (enabled) {
            const savedRate = clampPlaybackRate(
              state.trackPlaybackRatesByUrn[urn] ?? state.playbackRate ?? state.globalPlaybackRate,
            );

            return {
              playbackRate: savedRate,
              trackPlaybackRatesByUrn: {
                ...state.trackPlaybackRatesByUrn,
                [urn]: savedRate,
              },
              trackPlaybackRateEnabledByUrn: {
                ...state.trackPlaybackRateEnabledByUrn,
                [urn]: true,
              },
            };
          }

          return {
            playbackRate: 1,
            globalPlaybackRate: 1,
            trackPlaybackRateEnabledByUrn: removeTrackPlaybackRateKey(
              state.trackPlaybackRateEnabledByUrn,
              urn,
            ),
          };
        }),
      setPitchSemitones: (value) => set({ pitchSemitones: clampPitchSemitones(value) }),
      resetPitchSemitones: () => set({ pitchSemitones: 0 }),
      setPitchControlMode: (mode) => set({ pitchControlMode: mode }),

      setQueue: (queue) =>
        set((s) => {
          const uniqueQueue = dedupeTracks(queue);
          const idx = s.currentTrack
            ? uniqueQueue.findIndex((t) => t.urn === s.currentTrack!.urn)
            : -1;
          return {
            queue: uniqueQueue,
            queueIndex: idx >= 0 ? idx : s.queueIndex,
            originalQueue: s.shuffle ? [...uniqueQueue] : null,
          };
        }),

      addToQueue: (tracks) =>
        set((s) => {
          const queue = appendUniqueTracks(s.queue, tracks);
          const originalQueue = s.originalQueue
            ? appendUniqueTracks(s.originalQueue, tracks)
            : null;
          return { queue, originalQueue };
        }),

      addToQueueNext: (tracks) =>
        set((s) => {
          const insertIndex = s.queueIndex >= 0 ? s.queueIndex + 1 : 0;
          const queue = insertUniqueTracks(s.queue, tracks, insertIndex);
          return {
            queue,
            originalQueue: s.originalQueue ? appendUniqueTracks(s.originalQueue, tracks) : null,
          };
        }),

      removeFromQueue: (index) =>
        set((s) => {
          const removed = s.queue[index];
          const queue = s.queue.filter((_, i) => i !== index);
          const queueIndex =
            index < s.queueIndex
              ? s.queueIndex - 1
              : index === s.queueIndex
                ? Math.min(s.queueIndex, queue.length - 1)
                : s.queueIndex;
          let originalQueue = s.originalQueue;
          if (originalQueue && removed) {
            const oq = [...originalQueue];
            const oi = oq.findIndex((t) => t.urn === removed.urn);
            if (oi >= 0) oq.splice(oi, 1);
            originalQueue = oq;
          }
          return { queue, queueIndex, originalQueue };
        }),

      moveInQueue: (from, to) =>
        set((s) => {
          const queue = [...s.queue];
          const [item] = queue.splice(from, 1);
          queue.splice(to, 0, item);
          let queueIndex = s.queueIndex;
          if (s.queueIndex === from) queueIndex = to;
          else if (from < s.queueIndex && to >= s.queueIndex) queueIndex--;
          else if (from > s.queueIndex && to <= s.queueIndex) queueIndex++;
          return { queue, queueIndex };
        }),

      clearQueue: () =>
        set({ queue: [], queueIndex: -1, queueSource: 'manual', originalQueue: null }),

      toggleShuffle: () => {
        const { shuffle, queue, queueIndex, currentTrack } = get();
        if (!shuffle) {
          const original = [...queue];
          const after = [...queue.slice(queueIndex + 1)];
          shuffleArray(after);
          set({
            shuffle: true,
            originalQueue: original,
            queue: [...queue.slice(0, queueIndex + 1), ...after],
          });
        } else {
          const { originalQueue } = get();
          if (originalQueue && currentTrack) {
            const idx = originalQueue.findIndex((t) => t.urn === currentTrack.urn);
            set({
              shuffle: false,
              queue: originalQueue,
              queueIndex: idx >= 0 ? idx : 0,
              originalQueue: null,
            });
          } else {
            set({ shuffle: false, originalQueue: null });
          }
        }
      },

      toggleRepeat: () =>
        set((s) => ({
          repeat: s.repeat === 'off' ? 'all' : s.repeat === 'all' ? 'one' : 'off',
        })),

      setCurrentTrackAccess: (access) =>
        set((s) => (s.currentTrack ? { currentTrack: { ...s.currentTrack, access } } : {})),
      setTrackAccessByUrn: (urn, access) =>
        set((s) => ({
          currentTrack:
            s.currentTrack?.urn === urn ? { ...s.currentTrack, access } : s.currentTrack,
          queue: s.queue.map((track) => (track.urn === urn ? { ...track, access } : track)),
          originalQueue: s.originalQueue
            ? s.originalQueue.map((track) => (track.urn === urn ? { ...track, access } : track))
            : null,
        })),
      setCurrentTrackStreamQuality: (streamQuality) =>
        set((s) => (s.currentTrack ? { currentTrack: { ...s.currentTrack, streamQuality } } : {})),
      setCurrentTrackStreamCodec: (streamCodec) =>
        set((s) => (s.currentTrack ? { currentTrack: { ...s.currentTrack, streamCodec } } : {})),
      replaceTrackMetadata: (track) =>
        set((s) => {
          const update = (t: Track) => (t.urn === track.urn ? { ...t, ...track } : t);
          return {
            currentTrack: s.currentTrack ? update(s.currentTrack) : s.currentTrack,
            queue: s.queue.map(update),
            originalQueue: s.originalQueue ? s.originalQueue.map(update) : null,
          };
        }),
    }),
    {
      name: 'sc-player',
      storage: createJSONStorage(() => tauriStorage),
      version: 7,
      migrate: (persistedState) => {
        const state = (
          persistedState && typeof persistedState === 'object' ? persistedState : {}
        ) as Partial<PlayerState>;
        return state;
      },
      merge: (persistedState, currentState) => {
        const state = (
          persistedState && typeof persistedState === 'object' ? persistedState : {}
        ) as Partial<PlayerState>;
        const trackPlaybackRatesByUrn = sanitizeTrackPlaybackRates(state.trackPlaybackRatesByUrn);
        const trackPlaybackRateEnabledByUrn = sanitizeTrackPlaybackRateEnabledMap(
          state.trackPlaybackRateEnabledByUrn,
        );
        const globalPlaybackRate = clampPlaybackRate(
          state.globalPlaybackRate ?? state.playbackRate ?? currentState.globalPlaybackRate,
        );
        const currentTrack = state.currentTrack ?? currentState.currentTrack;

        return {
          ...currentState,
          ...state,
          playbackRate: resolvePlaybackRateForTrack(
            currentTrack,
            globalPlaybackRate,
            trackPlaybackRateEnabledByUrn,
            trackPlaybackRatesByUrn,
          ),
          globalPlaybackRate,
          trackPlaybackRatesByUrn,
          trackPlaybackRateEnabledByUrn,
          pitchSemitones: clampPitchSemitones(state.pitchSemitones ?? currentState.pitchSemitones),
          pitchControlMode: state.pitchControlMode === 'auto' ? 'auto' : 'manual',
        };
      },
      partialize: (state) => ({
        volume: state.volume,
        volumeBeforeMute: state.volumeBeforeMute,
        playbackRate: state.playbackRate,
        globalPlaybackRate: state.globalPlaybackRate,
        trackPlaybackRatesByUrn: state.trackPlaybackRatesByUrn,
        trackPlaybackRateEnabledByUrn: state.trackPlaybackRateEnabledByUrn,
        pitchSemitones: state.pitchSemitones,
        pitchControlMode: state.pitchControlMode,
        currentTrack: state.currentTrack,
        queue: state.queue,
        originalQueue: state.originalQueue,
        queueIndex: state.queueIndex,
        shuffle: state.shuffle,
        repeat: state.repeat,
      }),
    },
  ),
);

usePlayerStore.subscribe((state, prev) => {
  if (state.currentTrack?.urn === prev.currentTrack?.urn) return;

  const nextPlaybackRate = resolvePlaybackRateForTrack(
    state.currentTrack,
    state.globalPlaybackRate,
    state.trackPlaybackRateEnabledByUrn,
    state.trackPlaybackRatesByUrn,
  );

  if (Math.abs(state.playbackRate - nextPlaybackRate) < 0.001) return;
  usePlayerStore.setState({ playbackRate: nextPlaybackRate });
});
