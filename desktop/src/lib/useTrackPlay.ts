import { useCallback, useEffect, useRef } from 'react';
import { type Track, usePlayerStore } from '../stores/player';
import { rememberTracks } from './offline-index';

/**
 * Optimized hook for track play/pause.
 * Only re-renders when THIS track's play state changes, not on every global isPlaying toggle.
 */
export function useTrackPlay(track: Track, queue?: Track[]) {
  const isThis = usePlayerStore((s) => s.currentTrack?.urn === track.urn);
  const isThisPlaying = usePlayerStore((s) => s.currentTrack?.urn === track.urn && s.isPlaying);

  const trackRef = useRef(track);
  const queueRef = useRef(queue);
  trackRef.current = track;
  queueRef.current = queue;

  useEffect(() => {
    void rememberTracks([track]);
  }, [track]);

  const togglePlay = useCallback(() => {
    const { play, pause, resume } = usePlayerStore.getState();
    if (isThisPlaying) pause();
    else if (isThis) resume();
    else play(trackRef.current, queueRef.current ?? [trackRef.current]);
  }, [isThis, isThisPlaying]);

  return { isThis, isThisPlaying, togglePlay };
}

/**
 * Check if any track from a set of URNs is currently playing.
 * Only re-renders when the result changes.
 */
export function useIsPlayingFrom(trackUrns: Set<string>) {
  return usePlayerStore(
    (s) => s.isPlaying && s.currentTrack != null && trackUrns.has(s.currentTrack.urn),
  );
}
