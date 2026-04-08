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
  pitchSemitones: number;
  pitchControlMode: PitchControlMode;
  shuffle: boolean;
  repeat: RepeatMode;

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
      pitchSemitones: 0,
      pitchControlMode: 'manual',
      shuffle: false,
      repeat: 'off',

      play: (track, queue, source = 'manual') => {
        if (queue) {
          const uniqueQueue = dedupeTracks(queue);
          const { shuffle } = get();
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
              originalQueue: original,
            });
          } else {
            set({
              currentTrack: track,
              queue: uniqueQueue,
              queueIndex: realIdx,
              queueSource: source,
              isPlaying: true,
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
          });
        }
      },

      playFromQueue: (index) => {
        const { queue } = get();
        if (index < 0 || index >= queue.length) return;
        set({
          currentTrack: queue[index],
          queueIndex: index,
          isPlaying: true,
        });
      },

      pause: () => set({ isPlaying: false }),
      resume: () => set({ isPlaying: true }),

      togglePlay: () => {
        const { isPlaying, currentTrack } = get();
        if (currentTrack) set({ isPlaying: !isPlaying });
      },

      next: () => {
        const { queue, queueIndex, repeat } = get();
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

        set({
          currentTrack: queue[nextIdx],
          queueIndex: nextIdx,
          isPlaying: true,
        });
      },

      prev: () => {
        const { queue, queueIndex } = get();
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

        set({
          currentTrack: queue[prevIdx],
          queueIndex: prevIdx,
          isPlaying: true,
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

      setPlaybackRate: (rate) => set({ playbackRate: clampPlaybackRate(rate) }),
      resetPlaybackRate: () => set({ playbackRate: 1 }),
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
          // ON: save original order, shuffle everything after current track
          const original = [...queue];
          const after = [...queue.slice(queueIndex + 1)];
          shuffleArray(after);
          set({
            shuffle: true,
            originalQueue: original,
            queue: [...queue.slice(0, queueIndex + 1), ...after],
          });
        } else {
          // OFF: restore original order
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
    }),
    {
      name: 'sc-player',
      storage: createJSONStorage(() => tauriStorage),
      version: 6,
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

        return {
          ...currentState,
          ...state,
          playbackRate: clampPlaybackRate(state.playbackRate ?? currentState.playbackRate),
          pitchSemitones: clampPitchSemitones(state.pitchSemitones ?? currentState.pitchSemitones),
          pitchControlMode: state.pitchControlMode === 'auto' ? 'auto' : 'manual',
        };
      },
      partialize: (state) => ({
        volume: state.volume,
        volumeBeforeMute: state.volumeBeforeMute,
        playbackRate: state.playbackRate,
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
