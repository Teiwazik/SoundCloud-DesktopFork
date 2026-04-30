import { useQuery } from '@tanstack/react-query';
import type { Track } from '../stores/player';
import { api } from './api';
import { isUrnLiked } from './likes';

export interface RecommendResult {
  id: string | number;
  score?: number;
  payload?: Record<string, unknown>;
}

export interface IndexingStats {
  indexed: number;
  pending: number;
}

/**
 * Soundwave queries are intentionally NOT cached — diversity/languages/hideLiked
 * are tweakable knobs and we must refetch on every change. Any staleTime here
 * silently hides slider movements.
 */
const SW_STALE_MS = 0;
const SW_GC_MS = 1000 * 60 * 5;

/**
 * Extract comma-separated, sorted languages for a stable cache key.
 * Empty array → undefined so we don't send ?languages= to backend.
 */
function normLanguages(langs: string[] | undefined): string | undefined {
  if (!langs || langs.length === 0) return undefined;
  return [...langs].sort().join(',');
}

/**
 * Hydrate Qdrant numeric IDs → full SC track metadata, preserving recommendation order.
 *
 * We deliberately do NOT batch this through `/tracks?ids=...`. That endpoint
 * (public SC search) returns *preview* tracks (duration=30s), which forces the
 * audio engine into `resolveTrackFromStreaming()` fallback — and that fails
 * on tracks the streaming service can't resolve from the permalink. Per-track
 * `/tracks/:urn` returns the full metadata with real duration. Backend caches
 * these for 10m, so on a warm cache this is effectively free; on a cold cache
 * the 20-24 requests fan out in parallel.
 */
export async function hydrateByIds(recs: RecommendResult[]): Promise<Track[]> {
  const urns = recs
    .map((r) => {
      const id = String(r.id);
      return id ? `soundcloud:tracks:${id}` : null;
    })
    .filter((u): u is string => u !== null);
  if (!urns.length) return [];

  const results = await Promise.all(
    urns.map((urn) =>
      api<Track>(`/tracks/${encodeURIComponent(urn)}`).catch(() => null as Track | null),
    ),
  );

  return results.filter((t): t is Track => t !== null);
}

export type SoundWaveMode = 'similar' | 'diverse';

export function useSoundWave(opts: {
  enabled?: boolean;
  languages?: string[];
  limit?: number;
  mode?: SoundWaveMode;
  hideLiked?: boolean;
}) {
  const limit = opts.limit ?? 24;
  const languages = normLanguages(opts.languages);
  const mode: SoundWaveMode = opts.mode ?? 'similar';
  const hideLiked = !!opts.hideLiked;

  return useQuery({
    queryKey: ['soundwave', 'recs', limit, languages ?? 'all', mode, hideLiked],
    enabled: opts.enabled !== false,
    staleTime: SW_STALE_MS,
    gcTime: SW_GC_MS,
    queryFn: async () => {
      const qs = new URLSearchParams({ limit: String(limit), mode });
      if (languages) qs.set('languages', languages);

      const recs = await api<RecommendResult[]>(`/recommendations?${qs}`).catch(
        () => [] as RecommendResult[],
      );
      if (!recs.length) return { tracks: [] as Track[], recs };

      const hydrated = await hydrateByIds(recs);
      const tracks = hideLiked
        ? hydrated.filter((t) => !t.user_favorite && !isUrnLiked(t.urn))
        : hydrated;
      return { tracks, recs };
    },
  });
}

/**
 * Text → Audio search via MuQ-MuLan. Free-form "vibe" description.
 * Returns hydrated tracks preserving Qdrant score order.
 */
export function useSoundWaveSearch(opts: { q: string; languages?: string[]; limit?: number }) {
  const q = opts.q.trim();
  const limit = opts.limit ?? 24;
  const languages = normLanguages(opts.languages);

  return useQuery({
    queryKey: ['soundwave', 'search', q, limit, languages ?? 'all'],
    enabled: q.length >= 2,
    staleTime: SW_STALE_MS,
    gcTime: SW_GC_MS,
    queryFn: async () => {
      const qs = new URLSearchParams({ q, limit: String(limit) });
      if (languages) qs.set('languages', languages);

      const recs = await api<RecommendResult[]>(
        `/recommendations/search?${qs}`,
        { timeoutMs: 30_000 },
      ).catch(() => [] as RecommendResult[]);
      if (!recs.length) return { tracks: [] as Track[], recs };

      const tracks = await hydrateByIds(recs);
      return { tracks, recs };
    },
  });
}

/**
 * Pure similar-by-track — TrackPage. Без taste юзера, без скипов/дизлайков.
 * Diversity тут по желанию (сейчас не прокидывается из UI).
 */
export function useSoundWaveSimilar(opts: {
  trackId: string | undefined;
  limit?: number;
  diversity?: number;
}) {
  const trackId = opts.trackId;
  const limit = opts.limit ?? 24;
  const diversity = Math.max(0, Math.min(1, opts.diversity ?? 0));

  return useQuery({
    queryKey: ['soundwave', 'similar', trackId, limit, diversity],
    enabled: !!trackId,
    staleTime: SW_STALE_MS,
    gcTime: SW_GC_MS,
    queryFn: async () => {
      const qs = new URLSearchParams({ limit: String(limit) });
      if (diversity > 0) qs.set('diversity', diversity.toFixed(2));

      const recs = await api<RecommendResult[]>(
        `/recommendations/similar/${encodeURIComponent(trackId!)}?${qs}`,
      ).catch(() => [] as RecommendResult[]);
      if (!recs.length) return { tracks: [] as Track[], recs };

      const tracks = await hydrateByIds(recs);
      return { tracks, recs };
    },
  });
}

/**
 * Бесконечный tail SoundWave: taste + anchor + mode.
 * Используется home-block при расширении очереди.
 */
export async function fetchWaveTailFromSeed(
  seedTrackId: string,
  opts: { languages?: string[]; mode: SoundWaveMode; limit?: number },
): Promise<RecommendResult[]> {
  const qs = new URLSearchParams({
    limit: String(opts.limit ?? 20),
    mode: opts.mode,
  });
  const languages = normLanguages(opts.languages);
  if (languages) qs.set('languages', languages);
  return api<RecommendResult[]>(
    `/recommendations/wave/${encodeURIComponent(seedTrackId)}?${qs}`,
  ).catch(() => [] as RecommendResult[]);
}

/** Optional lightweight poll of indexing stats. Fails silently if endpoint absent. */
export function useIndexingStats() {
  return useQuery({
    queryKey: ['soundwave', 'indexing-stats'],
    staleTime: 1000 * 30,
    gcTime: 1000 * 60 * 5,
    retry: false,
    queryFn: () => api<IndexingStats>('/indexing/stats').catch(() => null as IndexingStats | null),
  });
}
