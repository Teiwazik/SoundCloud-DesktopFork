import { create } from 'zustand';
import { fetchAndCacheTrack, isCached } from '../lib/cache';

export type CacheTaskStatus = 'idle' | 'running' | 'paused';

interface CacheTaskState {
  status: CacheTaskStatus;
  queue: string[];
  currentIndex: number;
  total: number;
  completed: number;
  skipped: number;
  failed: number;

  startBatch: (urns: string[]) => void;
  pauseBatch: () => void;
  resumeBatch: () => void;
  stopBatch: () => void;
}

const CONCURRENCY = 3;
let activeWorkers = 0;
let currentAbortController: AbortController | null = null;

export const useCacheTaskStore = create<CacheTaskState>((set, get) => {
  const tick = async () => {
    const state = get();
    if (state.status !== 'running') return;

    if (state.currentIndex >= state.queue.length) {
      if (activeWorkers === 0) {
        set({ status: 'idle' });
      }
      return;
    }

    if (activeWorkers >= CONCURRENCY) return;
    activeWorkers++;

    const index = get().currentIndex;
    set({ currentIndex: index + 1 });
    const urn = get().queue[index];

    const signal = currentAbortController?.signal;

    try {
      if (await isCached(urn)) {
        if (get().status === 'running') set((s) => ({ skipped: s.skipped + 1 }));
      } else {
        await fetchAndCacheTrack(urn, signal);
        if (get().status === 'running') set((s) => ({ completed: s.completed + 1 }));
      }
    } catch (err: any) {
      if (err.name !== 'AbortError' && get().status === 'running') {
        set((s) => ({ failed: s.failed + 1 }));
      }
    } finally {
      activeWorkers--;
      if (get().status === 'running') {
        setTimeout(tick, 10);
      }
    }
  };

  return {
    status: 'idle',
    queue: [],
    currentIndex: 0,
    total: 0,
    completed: 0,
    skipped: 0,
    failed: 0,

    startBatch: (urns: string[]) => {
      const uniqueUrns = [...new Set(urns.filter(Boolean))];
      if (uniqueUrns.length === 0) return;

      if (currentAbortController) {
        currentAbortController.abort();
      }
      currentAbortController = new AbortController();

      set({
        status: 'running',
        queue: uniqueUrns,
        currentIndex: 0,
        total: uniqueUrns.length,
        completed: 0,
        skipped: 0,
        failed: 0,
      });

      for (let i = 0; i < CONCURRENCY; i++) {
        tick();
      }
    },

    pauseBatch: () => {
      const state = get();
      if (state.status === 'running') {
        set({ status: 'paused' });
        if (currentAbortController) {
          currentAbortController.abort();
          currentAbortController = null;
        }
      }
    },

    resumeBatch: () => {
      const state = get();
      if (state.status === 'paused') {
        set({ status: 'running' });
        currentAbortController = new AbortController();
        for (let i = activeWorkers; i < CONCURRENCY; i++) {
          tick();
        }
      }
    },

    stopBatch: () => {
      set({ status: 'idle', queue: [], currentIndex: 0, total: 0 });
      if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
      }
    },
  };
});
