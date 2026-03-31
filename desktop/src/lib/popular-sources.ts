import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isTauri } from '@tauri-apps/api/core';
import type { Track } from '../stores/player';

interface ExternalHit {
  title: string;
  artist: string;
  region: string;
  platform: 'apple' | 'deezer';
  rank: number;
}

export interface RegionalTrendOptions {
  regions: string[];
  maxCandidates?: number;
  maxResolved?: number;
}

export type SearchTracksFn = (query: string, limit?: number) => Promise<Track[]>;

const DEFAULT_REGIONS = ['us', 'gb', 'de', 'fr', 'br', 'jp', 'kr', 'mx'];

async function fetchWithFallback(url: string): Promise<Response> {
  if (isTauri()) {
    try {
      return await tauriFetch(url, { method: 'GET' });
    } catch {}
  }
  return fetch(url);
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetchWithFallback(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9а-яё\s]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(value: string): Set<string> {
  return new Set(
    normalizeText(value)
      .split(' ')
      .filter((t) => t.length > 1),
  );
}

function overlapScore(a: string, b: string): number {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const token of sa) if (sb.has(token)) inter++;
  return inter / Math.max(sa.size, sb.size);
}

function uniqueByKey(items: ExternalHit[]): ExternalHit[] {
  const map = new Map<string, ExternalHit>();
  for (const item of items) {
    const key = `${normalizeText(item.artist)}::${normalizeText(item.title)}`;
    const prev = map.get(key);
    if (!prev || item.rank < prev.rank) {
      map.set(key, item);
    }
  }
  return [...map.values()];
}

async function fetchAppleRegion(region: string, limit: number): Promise<ExternalHit[]> {
  const data = (await fetchJson(`https://itunes.apple.com/${region}/rss/topsongs/limit=${limit}/json`)) as {
    feed?: {
      entry?: Array<{
        title?: { label?: string };
        'im:name'?: { label?: string };
        'im:artist'?: { label?: string };
      }>;
    };
  } | null;

  const entries = data?.feed?.entry || [];
  const output: ExternalHit[] = [];
  for (let i = 0; i < entries.length; i++) {
    const item = entries[i];
    const titleRaw = item.title?.label || item['im:name']?.label || '';
    const split = titleRaw.split(' - ');
    const parsedTitle = split.length > 1 ? split[0] : titleRaw;
    const parsedArtist = split.length > 1 ? split.slice(1).join(' - ') : item['im:artist']?.label || '';
    const title = parsedTitle.trim();
    const artist = parsedArtist.trim();
    if (!title || !artist) continue;
    output.push({ title, artist, region, platform: 'apple', rank: i + 1 });
  }
  return output;
}

async function fetchDeezerChart(limit: number): Promise<ExternalHit[]> {
  const data = (await fetchJson(`https://api.deezer.com/chart/0/tracks?limit=${limit}`)) as {
    data?: Array<{ title?: string; artist?: { name?: string } }>;
  } | null;
  const rows = data?.data || [];
  return rows
    .map((row, i) => ({
      title: (row.title || '').trim(),
      artist: (row.artist?.name || '').trim(),
      region: 'global',
      platform: 'deezer' as const,
      rank: i + 1,
    }))
    .filter((row) => row.title && row.artist);
}

async function runLimited<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let index = 0;
  const run = async () => {
    while (index < items.length) {
      const current = items[index++];
      out.push(await worker(current));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, limit) }, () => run()));
  return out;
}

async function resolveCandidateToTrack(candidate: ExternalHit, searchTracks: SearchTracksFn): Promise<Track | null> {
  const queries = [
    `${candidate.artist} ${candidate.title}`,
    `${candidate.title} ${candidate.artist}`,
    candidate.title,
  ];

  let best: Track | null = null;
  let bestScore = 0;

  for (const query of queries) {
    const found = await searchTracks(query, 6);
    for (const track of found) {
      if (!track?.urn || !track.user?.username || !track.title) continue;
      const titleScore = overlapScore(track.title, candidate.title);
      const artistScore = overlapScore(track.user.username, candidate.artist);
      const score = titleScore * 0.68 + artistScore * 0.32;
      if (score > bestScore) {
        bestScore = score;
        best = track;
      }
    }
    if (bestScore > 0.72) break;
  }

  if (!best || bestScore < 0.36) return null;

  const mergedTagList = [best.tag_list || '', `region:${candidate.region}`, `source:${candidate.platform}`]
    .join(' ')
    .trim();

  return {
    ...best,
    tag_list: mergedTagList,
    playback_count: (best.playback_count || 0) + Math.max(0, 120000 - candidate.rank * 2000),
  };
}

export async function fetchCrossPlatformRegionalTracks(
  searchTracks: SearchTracksFn,
  options: Partial<RegionalTrendOptions> = {},
): Promise<Track[]> {
  const regions = (options.regions && options.regions.length > 0 ? options.regions : DEFAULT_REGIONS)
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 12);

  const maxCandidates = Math.max(20, Math.min(160, options.maxCandidates || 72));
  const maxResolved = Math.max(8, Math.min(80, options.maxResolved || 36));

  const applePromises = regions.map((region) => fetchAppleRegion(region, 14));
  const [deezerHits, ...appleHits] = await Promise.all([fetchDeezerChart(24), ...applePromises]);

  const candidates = uniqueByKey([...deezerHits, ...appleHits.flat()])
    .sort((a, b) => a.rank - b.rank)
    .slice(0, maxCandidates);

  const resolved = await runLimited(candidates, 3, async (candidate) => {
    try {
      return await resolveCandidateToTrack(candidate, searchTracks);
    } catch {
      return null;
    }
  });

  const seen = new Set<string>();
  const output: Track[] = [];
  for (const track of resolved) {
    if (!track?.urn || seen.has(track.urn)) continue;
    seen.add(track.urn);
    output.push(track);
    if (output.length >= maxResolved) break;
  }

  return output;
}
