import { useEffect, useRef } from 'react';
import type { Track } from '../../../stores/player';
import { usePlayerStore } from '../../../stores/player';

/**
 * Infinite SoundWave queue.
 *
 * When the user starts listening from a SoundWave shelf (either Home or the
 * TrackPage similar block), we keep extending their queue so the wave never
 * runs out. The hook watches the player store, and once the remaining tail is
 * short AND the currently playing track is one we originally queued, it asks
 * the caller for more tracks and appends everything that isn't already in the
 * queue.
 *
 * @param enabled  Turn the watcher on/off.
 * @param tracks   The current visible shelf — treated as the "seed" of tracks
 *                 this hook is responsible for.
 * @param fetchMore Async function returning the next batch of recommendations.
 * @param minTail  When `queue.length - queueIndex` drops to this value, refill.
 */
export function useInfiniteWave(opts: {
  enabled: boolean;
  tracks: Track[];
  fetchMore: () => Promise<Track[]>;
  minTail?: number;
}) {
  const { enabled, tracks, fetchMore, minTail = 3 } = opts;

  // Set of URNs that belong to our SoundWave shelf — used as the authorization
  // rule for auto-refill (never touch queues that didn't originate here).
  const ownedRef = useRef<Set<string>>(new Set());
  const fetchingRef = useRef(false);
  const fetchMoreRef = useRef(fetchMore);

  useEffect(() => {
    fetchMoreRef.current = fetchMore;
  }, [fetchMore]);

  // Keep the ownership set in sync with the latest shelf — includes previously
  // seeded tracks plus any newly-fetched ones added to the queue.
  useEffect(() => {
    for (const t of tracks) ownedRef.current.add(t.urn);
  }, [tracks]);

  useEffect(() => {
    if (!enabled) return;

    return usePlayerStore.subscribe((state) => {
      const { queue, queueIndex, currentTrack } = state;
      if (!currentTrack) return;
      if (!ownedRef.current.has(currentTrack.urn)) return;
      const remaining = queue.length - queueIndex - 1;
      if (remaining > minTail) return;
      if (fetchingRef.current) return;

      fetchingRef.current = true;
      (async () => {
        try {
          const next = await fetchMoreRef.current();
          const existing = new Set(usePlayerStore.getState().queue.map((t) => t.urn));
          const fresh = next.filter((t) => !existing.has(t.urn));
          if (fresh.length > 0) {
            usePlayerStore.getState().addToQueue(fresh);
            for (const t of fresh) ownedRef.current.add(t.urn);
          }
        } catch (e) {
          console.debug('[soundwave] infinite refill failed:', e);
        } finally {
          fetchingRef.current = false;
        }
      })();
    });
  }, [enabled, minTail]);
}
