import { create } from 'zustand';
import { api } from '../lib/api';
import { type AudioFeatures, audioAnalyser } from '../lib/audio-analyser';
import { type FeedItem, fetchAllLikedTracks, type Playlist } from '../lib/hooks';
import {
  analyzeTrackLanguage,
  detectLanguage,
  filterByLanguage,
  type TrackLanguageProfile,
} from '../lib/language-detection';
import { rerankTracksWithLLM } from '../lib/llm-rerank';
import { fetchCrossPlatformRegionalTracks } from '../lib/popular-sources';
import { QdrantClient, type QdrantScoredPoint } from '../lib/qdrant';
import { useAuthStore } from './auth';
import { useDislikesStore } from './dislikes';
import { type Track, usePlayerStore } from './player';
import { useSettingsStore } from './settings';

export interface SoundWavePreset {
  // ...
  name: string;
  icon: string;
  tags?: string[];
  mode?: 'favorite' | 'discover' | 'popular';
  palette?: string;
  timeHours?: number[];
}

export const ACTIVITY_PRESETS: Record<string, SoundWavePreset> = {
  wakeup: {
    name: 'Просыпаюсь',
    icon: 'sun',
    tags: ['chill', 'morning', 'acoustic', 'lo-fi'],
    timeHours: [5, 6, 7, 8, 9],
  },
  commute: {
    name: 'В дороге',
    icon: 'car',
    tags: ['electronic', 'pop', 'indie', 'drive'],
    timeHours: [7, 8, 9, 17, 18, 19],
  },
  work: {
    name: 'Работаю',
    icon: 'laptop',
    tags: ['focus', 'ambient', 'lo-fi', 'instrumental'],
    timeHours: [9, 10, 11, 12, 13, 14, 15, 16, 17],
  },
  workout: {
    name: 'Тренируюсь',
    icon: 'dumbbell',
    tags: ['workout', 'edm', 'trap', 'bass', 'energy', 'hype'],
    timeHours: [6, 7, 8, 17, 18, 19, 20],
  },
  sleep: {
    name: 'Засыпаю',
    icon: 'moon',
    tags: ['ambient', 'sleep', 'calm', 'piano', 'relax'],
    timeHours: [21, 22, 23, 0, 1, 2, 3],
  },
};

export const MOOD_PRESETS: Record<string, SoundWavePreset> = {
  energetic: {
    name: 'Бодрое',
    icon: 'zap',
    tags: ['energetic', 'upbeat', 'hype', 'edm', 'bass'],
    palette: 'energetic',
  },
  happy: {
    name: 'Весёлое',
    icon: 'music',
    tags: ['happy', 'fun', 'party', 'dance', 'pop'],
    palette: 'happy',
  },
  calm: {
    name: 'Спокойное',
    icon: 'waves',
    tags: ['calm', 'chill', 'peaceful', 'mellow', 'ambient'],
    palette: 'calm',
  },
  sad: {
    name: 'Грустное',
    icon: 'frown',
    tags: ['sad', 'emotional', 'melancholy', 'dark', 'indie'],
    palette: 'sad',
  },
};

export const CHARACTER_PRESETS: Record<string, SoundWavePreset> = {
  favorite: { name: 'Любимое', icon: 'heart', mode: 'favorite' },
  discover: { name: 'Незнакомое', icon: 'sparkles', mode: 'discover' },
  popular: { name: 'Популярное', icon: 'zap', mode: 'popular' },
};

export type MoodLabel = 'energetic' | 'happy' | 'calm' | 'sad';

const MOOD_TRAINING_PROFILES: Record<MoodLabel, Partial<AudioFeatures>> = {
  energetic: { valence: 0.75, arousal: 0.92, rmsEnergy: 0.85, flux: 0.65 },
  happy: { valence: 0.9, arousal: 0.64, rmsEnergy: 0.68, flux: 0.42 },
  calm: { valence: 0.46, arousal: 0.22, rmsEnergy: 0.25, flux: 0.16 },
  sad: { valence: 0.18, arousal: 0.2, rmsEnergy: 0.3, flux: 0.21 },
};

const withMoodProfile = (features: AudioFeatures | null, mood: MoodLabel): AudioFeatures => {
  const base: AudioFeatures = features || {
    rmsEnergy: 0.35,
    centroid: 0.35,
    flatness: 0.3,
    rolloff: 0.32,
    flux: 0.24,
    valence: 0.5,
    arousal: 0.5,
    bpm: 0,
  };

  return {
    ...base,
    ...MOOD_TRAINING_PROFILES[mood],
  };
};

const sanitizeCollectionPart = (value: string) => {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return normalized || 'user';
};

const buildScopedCollection = (baseCollection: string, userScope: string) => {
  const base = sanitizeCollectionPart(baseCollection || 'sw_v2');
  const scope = sanitizeCollectionPart(userScope || 'local');
  return `${base}_${scope}`.slice(0, 120);
};

const extractPlaylistTracks = (
  input: { collection: Playlist[] } | Playlist[] | null | undefined,
) => {
  if (!input) return [] as Track[];
  const collection = Array.isArray(input) ? input : input.collection || [];
  const tracks: Track[] = [];
  for (const playlist of collection) {
    if (!playlist?.tracks?.length) continue;
    for (const track of playlist.tracks) {
      if (track?.urn && track.user) tracks.push(track);
    }
  }
  return tracks;
};

const parseRegions = (value: string): string[] =>
  value
    .split(',')
    .map((r) => r.trim().toLowerCase())
    .filter((r) => /^[a-z]{2}$/.test(r))
    .slice(0, 12);

const COUNTRY_LANGUAGE_HINTS: Record<string, string> = {
  ru: 'ru',
  russia: 'ru',
  россия: 'ru',
  ua: 'uk',
  ukraine: 'uk',
  украина: 'uk',
  de: 'de',
  germany: 'de',
  deutschland: 'de',
  fr: 'fr',
  france: 'fr',
  es: 'es',
  spain: 'es',
  pt: 'pt',
  portugal: 'pt',
  br: 'pt',
  brazil: 'pt',
  pl: 'pl',
  poland: 'pl',
  tr: 'tr',
  turkey: 'tr',
  jp: 'ja',
  japan: 'ja',
  ja: 'ja',
  kr: 'ko',
  korea: 'ko',
  ko: 'ko',
  cn: 'zh',
  china: 'zh',
  zh: 'zh',
  in: 'hi',
  india: 'hi',
  hi: 'hi',
  sa: 'ar',
  ae: 'ar',
  arab: 'ar',
  arabia: 'ar',
};

const userRegionLanguageCache = new Map<string, string | null>();
const lyricsLanguageCache = new Map<number, string | null>();

const LANGUAGE_SCRIPT_REGEX: Record<string, RegExp> = {
  ru: /[\u0400-\u04FF]/,
  uk: /[іїєґІЇЄҐ]/,
  ar: /[\u0600-\u06FF]/,
  hi: /[\u0900-\u097F]/,
  ja: /[\u3040-\u30FF\u4E00-\u9FFF]/,
  ko: /[\uAC00-\uD7AF\u1100-\u11FF]/,
  zh: /[\u4E00-\u9FFF\u3400-\u4DBF]/,
};

const LANGUAGE_SEARCH_TERMS: Record<string, string[]> = {
  ru: ['русский рэп', 'русский поп', 'русская музыка'],
  uk: ['українська музика', 'український реп', 'ukrainian pop', 'ukrainian rap'],
  de: ['deutsche musik', 'deutschrap', 'deutscher pop', 'german dance'],
  fr: ['musique francaise', 'rap francais', 'chanson francaise', 'french dance'],
  es: ['musica latina', 'rap espanol', 'spanish pop'],
  pt: ['musica brasileira', 'rap brasileiro', 'portuguese music'],
  it: ['musica italiana', 'italian rap', 'italian pop', 'canzone italiana'],
  pl: ['polski rap', 'polska muzyka', 'polish music'],
  tr: ['turkce muzik', 'turkish rap', 'turkish pop'],
  ja: ['japanese music', 'jpop', 'japanese rap'],
  ko: ['kpop', 'korean rap', 'korean music'],
  zh: ['mandarin pop', 'chinese music', 'c-pop'],
  ar: ['arabic music', 'arab pop', 'arabic rap'],
  hi: ['hindi songs', 'bollywood music', 'hindi rap'],
};

const inferLanguageFromRegion = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const normalized = value.toLowerCase().trim();
  if (!normalized) return null;

  if (COUNTRY_LANGUAGE_HINTS[normalized]) {
    return COUNTRY_LANGUAGE_HINTS[normalized];
  }

  for (const [key, lang] of Object.entries(COUNTRY_LANGUAGE_HINTS)) {
    if (normalized.includes(key)) {
      return lang;
    }
  }

  return null;
};

const mapConcurrent = async <T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> => {
  const output = new Array<R>(items.length);
  let nextIndex = 0;

  const run = async () => {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      output[current] = await worker(items[current]);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, () => run()),
  );

  return output;
};

const fetchAuthorRegionLanguage = async (track: Track): Promise<string | null> => {
  const userUrn = track.user?.urn;
  if (!userUrn) return null;

  if (userRegionLanguageCache.has(userUrn)) {
    return userRegionLanguageCache.get(userUrn) ?? null;
  }

  const localUser = track.user as Track['user'] & { country?: string | null; city?: string | null };
  const localHint =
    inferLanguageFromRegion(localUser.country) || inferLanguageFromRegion(localUser.city);
  if (localHint) {
    userRegionLanguageCache.set(userUrn, localHint);
    return localHint;
  }

  try {
    const profile = await api<{ country?: string | null; city?: string | null }>(
      `/users/${encodeURIComponent(userUrn)}`,
    );
    const profileHint =
      inferLanguageFromRegion(profile?.country) || inferLanguageFromRegion(profile?.city);
    userRegionLanguageCache.set(userUrn, profileHint ?? null);
    return profileHint ?? null;
  } catch {
    userRegionLanguageCache.set(userUrn, null);
    return null;
  }
};

const fetchLyricsLanguage = async (track: Track): Promise<string | null> => {
  if (!track.id || !track.user?.username || !track.title) return null;

  if (lyricsLanguageCache.has(track.id)) {
    return lyricsLanguageCache.get(track.id) ?? null;
  }

  try {
    const q = encodeURIComponent(
      `${track.user.username} ${track.title}`.replace(/\s+/g, ' ').trim(),
    );
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);

    const response = await fetch(`https://lrclib.net/api/search?q=${q}`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      lyricsLanguageCache.set(track.id, null);
      return null;
    }

    const data = (await response.json()) as Array<{ plainLyrics?: string; syncedLyrics?: string }>;
    const first = data?.[0];
    const lyricsText = first?.plainLyrics || first?.syncedLyrics || '';

    if (!lyricsText || lyricsText.length < 12) {
      lyricsLanguageCache.set(track.id, null);
      return null;
    }

    const detected = detectLanguage(lyricsText);
    lyricsLanguageCache.set(track.id, detected);
    return detected;
  } catch {
    lyricsLanguageCache.set(track.id, null);
    return null;
  }
};

const buildEnrichedLanguageProfile = async (track: Track): Promise<TrackLanguageProfile> => {
  const base = analyzeTrackLanguage(track);
  const titleLanguage = detectLanguage(track.title || '');
  const [regionLanguage, lyricsLanguage] = await Promise.all([
    fetchAuthorRegionLanguage(track),
    fetchLyricsLanguage(track),
  ]);

  const votes = new Map<string, number>();
  const addVote = (lang: string | null | undefined, weight: number) => {
    if (!lang) return;
    votes.set(lang, (votes.get(lang) || 0) + weight);
  };

  addVote(base.primaryLanguage, 1.4 + base.confidence);
  addVote(titleLanguage, 1.1);
  addVote(regionLanguage, 1.6);
  addVote(lyricsLanguage, 2.4);

  let primaryLanguage = base.primaryLanguage;
  let maxVote = 0;
  for (const [lang, weight] of votes.entries()) {
    if (weight > maxVote) {
      maxVote = weight;
      primaryLanguage = lang;
    }
  }

  return {
    trackId: track.id,
    languages: {
      ...base.languages,
      ...(regionLanguage ? { [regionLanguage]: (base.languages[regionLanguage] || 0) + 2 } : {}),
      ...(lyricsLanguage ? { [lyricsLanguage]: (base.languages[lyricsLanguage] || 0) + 3 } : {}),
      ...(titleLanguage ? { [titleLanguage]: (base.languages[titleLanguage] || 0) + 1 } : {}),
    },
    primaryLanguage,
    confidence: Math.min(1, maxVote / 3.5),
  };
};

const LANGUAGE_POOL_CACHE_TTL_MS = 1000 * 60 * 20;
const GLOBAL_DISCOVERY_CACHE_TTL_MS = 1000 * 60 * 15;

const languagePoolCache = new Map<string, { ts: number; tracks: Track[] }>();
const languagePoolInFlight = new Map<string, Promise<Track[]>>();

let globalDiscoveryCache: { ts: number; tracks: Track[] } | null = null;
let globalDiscoveryInFlight: Promise<Track[]> | null = null;
let inFlightGenerateBatch: Promise<Track[]> | null = null;

const isTrackLike = (value: unknown): value is Track => {
  const track = value as Track;
  return Boolean(track?.urn && track?.title && track?.user?.username);
};

const isTrackPlayable = (track: Track): boolean => {
  if (!track?.urn || !track?.user?.username || !track?.title) return false;
  if ((track.access || 'playable') === 'blocked') return false;
  if (typeof track.duration === 'number' && track.duration > 0 && track.duration < 15000)
    return false;
  return true;
};

const trackMatchesPreferredLanguage = (track: Track, preferredLanguage: string): boolean => {
  const text = `${track.title || ''} ${track.description || ''} ${track.user?.username || ''}`;
  if (!text.trim()) return false;

  if (preferredLanguage === 'uk' && /[іїєґІЇЄҐ]/.test(text)) return true;
  const scriptRegex = LANGUAGE_SCRIPT_REGEX[preferredLanguage];
  if (scriptRegex && scriptRegex.test(text)) return true;

  return detectLanguage(text) === preferredLanguage;
};

const extractTracksFromPayload = (input: unknown): Track[] => {
  const collection = Array.isArray(input)
    ? input
    : ((input as { collection?: unknown[] } | null)?.collection ?? []);
  const result: Track[] = [];

  for (const item of collection) {
    const candidate =
      (item as { track?: unknown; origin?: unknown } | null)?.track ||
      (item as { track?: unknown; origin?: unknown } | null)?.origin ||
      item;
    if (isTrackLike(candidate) && isTrackPlayable(candidate)) {
      result.push(candidate);
    }
  }

  return result;
};

const buildFastLanguageProfile = (track: Track): TrackLanguageProfile => {
  const base = analyzeTrackLanguage(track);
  const text = `${track.title || ''} ${track.description || ''} ${track.user?.username || ''}`;
  const detected = detectLanguage(text);

  if (detected === base.primaryLanguage) {
    return base;
  }

  if (
    (base.primaryLanguage === 'en' && detected !== 'en') ||
    (base.primaryLanguage === 'ru' && detected === 'uk')
  ) {
    return {
      trackId: base.trackId,
      languages: {
        ...base.languages,
        [detected]: (base.languages[detected] || 0) + 2,
      },
      primaryLanguage: detected,
      confidence: Math.max(base.confidence, 0.6),
    };
  }

  return base;
};

const fetchGlobalDiscoveryTracks = async (): Promise<Track[]> => {
  if (
    globalDiscoveryCache &&
    Date.now() - globalDiscoveryCache.ts < GLOBAL_DISCOVERY_CACHE_TTL_MS
  ) {
    return globalDiscoveryCache.tracks;
  }
  if (globalDiscoveryInFlight) {
    return globalDiscoveryInFlight;
  }

  globalDiscoveryInFlight = (async () => {
    const endpoints = [
      '/charts?kind=top&genre=soundcloud:genres:all-music&limit=200',
      '/charts?kind=trending&genre=soundcloud:genres:all-music&limit=200',
      '/tracks?limit=200&linked_partitioning=true',
      '/tracks?limit=200&linked_partitioning=true&offset=200',
    ];

    const responses = await Promise.all(
      endpoints.map((endpoint) => api<unknown>(endpoint).catch(() => ({ collection: [] }))),
    );

    const dedup = new Map<string, Track>();
    for (const payload of responses) {
      const tracks = extractTracksFromPayload(payload);
      for (const track of tracks) {
        if (!dedup.has(track.urn)) {
          dedup.set(track.urn, track);
        }
      }
    }

    const tracks = Array.from(dedup.values()).slice(0, 700);
    globalDiscoveryCache = { ts: Date.now(), tracks };
    return tracks;
  })().finally(() => {
    globalDiscoveryInFlight = null;
  });

  return globalDiscoveryInFlight;
};

const applyLanguageFilterWithEnrichment = async <T extends Track>(
  tracks: T[],
  preferredLanguage: string,
): Promise<{ filtered: T[]; profiles: Map<number, TrackLanguageProfile> }> => {
  const playableTracks = tracks.filter((track) => isTrackPlayable(track as Track));

  const quickProfiles = new Map<number, TrackLanguageProfile>();
  for (const track of playableTracks) {
    quickProfiles.set(track.id, buildFastLanguageProfile(track as Track));
  }

  if (preferredLanguage === 'all') {
    return { filtered: playableTracks, profiles: quickProfiles };
  }

  let filtered = filterByLanguage(playableTracks, quickProfiles, preferredLanguage);
  const quickEnoughThreshold = Math.min(20, Math.max(10, Math.floor(playableTracks.length * 0.14)));
  if (filtered.length >= quickEnoughThreshold) {
    return { filtered, profiles: quickProfiles };
  }

  const candidatesForEnrichment = playableTracks
    .filter((track) => {
      const profile = quickProfiles.get(track.id);
      if (!profile) return true;
      if (profile.primaryLanguage === preferredLanguage) return true;
      if (profile.confidence < 0.55) return true;
      if (profile.primaryLanguage === 'en') return true;
      return false;
    })
    .slice(0, 140);

  if (candidatesForEnrichment.length > 0) {
    const deepProfiles = await mapConcurrent(candidatesForEnrichment, 6, async (track) =>
      buildEnrichedLanguageProfile(track as Track),
    );
    for (const profile of deepProfiles) {
      quickProfiles.set(profile.trackId, profile);
    }
    filtered = filterByLanguage(playableTracks, quickProfiles, preferredLanguage);
  }

  if (filtered.length === 0) {
    const scriptRegex = LANGUAGE_SCRIPT_REGEX[preferredLanguage];
    if (scriptRegex) {
      const scriptMatches = playableTracks.filter((track) =>
        scriptRegex.test(`${track.title || ''} ${track.description || ''}`),
      );
      if (scriptMatches.length > 0) {
        for (const track of scriptMatches) {
          const existing = quickProfiles.get(track.id);
          quickProfiles.set(track.id, {
            trackId: track.id,
            languages: {
              ...(existing?.languages || {}),
              [preferredLanguage]: (existing?.languages?.[preferredLanguage] || 0) + 2,
            },
            primaryLanguage: preferredLanguage,
            confidence: Math.max(existing?.confidence || 0, 0.65),
          });
        }
        filtered = scriptMatches;
      }
    }
  }

  return { filtered, profiles: quickProfiles };
};

const fetchLanguageSearchTracks = async (preferredLanguage: string): Promise<Track[]> => {
  const cached = languagePoolCache.get(preferredLanguage);
  if (cached && Date.now() - cached.ts < LANGUAGE_POOL_CACHE_TTL_MS) {
    return cached.tracks;
  }
  if (languagePoolInFlight.has(preferredLanguage)) {
    return languagePoolInFlight.get(preferredLanguage) as Promise<Track[]>;
  }

  const task = (async () => {
    const terms = LANGUAGE_SEARCH_TERMS[preferredLanguage] || [];

    const trackResponses = await Promise.all(
      terms.map(async (term) => {
        try {
          const params = new URLSearchParams({
            q: term,
            limit: '80',
            linked_partitioning: 'false',
          });
          const res = await api<unknown>(`/tracks?${params}`);
          return extractTracksFromPayload(res);
        } catch {
          return [] as Track[];
        }
      }),
    );

    const userResponses = await Promise.all(
      terms.slice(0, 4).map(async (term) => {
        try {
          const userParams = new URLSearchParams({
            q: term,
            limit: '16',
            linked_partitioning: 'false',
          });
          const usersRes = await api<{ collection?: Array<{ urn: string }> }>(
            `/users?${userParams}`,
          );
          const users = usersRes?.collection || [];

          const tracksByUsers = await Promise.all(
            users.slice(0, 10).map(async (user) => {
              try {
                const tracksParams = new URLSearchParams({
                  limit: '36',
                  linked_partitioning: 'false',
                });
                const tRes = await api<unknown>(
                  `/users/${encodeURIComponent(user.urn)}/tracks?${tracksParams}`,
                );
                return extractTracksFromPayload(tRes);
              } catch {
                return [] as Track[];
              }
            }),
          );

          return tracksByUsers.flat();
        } catch {
          return [] as Track[];
        }
      }),
    );

    const globalDiscoveryTracks = await fetchGlobalDiscoveryTracks().catch(() => [] as Track[]);
    const globalLanguageTracks = globalDiscoveryTracks.filter((track) =>
      trackMatchesPreferredLanguage(track, preferredLanguage),
    );

    const dedup = new Map<string, Track>();
    for (const list of [...trackResponses, ...userResponses, globalLanguageTracks]) {
      for (const track of list) {
        if (isTrackLike(track) && isTrackPlayable(track) && !dedup.has(track.urn)) {
          dedup.set(track.urn, track);
        }
      }
    }

    const tracks = Array.from(dedup.values()).slice(0, 420);
    languagePoolCache.set(preferredLanguage, { ts: Date.now(), tracks });
    return tracks;
  })().finally(() => {
    languagePoolInFlight.delete(preferredLanguage);
  });

  languagePoolInFlight.set(preferredLanguage, task);
  return task;
};

const rerankIfEnabled = async (
  tracks: Track[],
  preset: SoundWavePreset | null,
): Promise<Track[]> => {
  const settings = useSettingsStore.getState();
  if (!settings.llmRerankEnabled) return tracks;
  return rerankTracksWithLLM({
    endpoint: settings.llmEndpoint,
    model: settings.llmModel,
    tracks,
    moodHint: preset?.name,
    modeHint: preset?.mode,
  });
};

interface HistoryEntry {
  scTrackId: string;
  playedAt?: string;
}

interface HistoryResponse {
  collection: HistoryEntry[];
}

type RankedTrack = Track & {
  _swScore: number;
  _isLiked: boolean;
  _isHeard: boolean;
  _heardRank: number;
};

const normalizeTrackUrn = (value: string): string => {
  if (!value) return '';
  if (value.startsWith('soundcloud:tracks:')) return value;
  const match = value.match(/(\d+)/);
  return match ? `soundcloud:tracks:${match[1]}` : value;
};

const artistKey = (track: Track): string =>
  (track.user?.urn || track.user?.username || 'unknown').toLowerCase().trim();

const ratioByMode: Record<
  'favorite' | 'discover' | 'popular',
  { novel: number; heard: number; liked: number }
> = {
  discover: { novel: 0.86, heard: 0.14, liked: 0 },
  favorite: { novel: 0.58, heard: 0.24, liked: 0.18 },
  popular: { novel: 0.72, heard: 0.2, liked: 0.08 },
};

const modeKey = (preset: SoundWavePreset | null): 'favorite' | 'discover' | 'popular' => {
  if (preset?.mode === 'discover') return 'discover';
  if (preset?.mode === 'popular') return 'popular';
  return 'favorite';
};

const selectBalancedTracks = (
  input: RankedTrack[],
  preset: SoundWavePreset | null,
  limit: number,
): RankedTrack[] => {
  if (input.length === 0 || limit <= 0) return [];

  const seen = new Set<string>();
  const unique = input.filter((track) => {
    if (!track.urn || seen.has(track.urn)) return false;
    seen.add(track.urn);
    return true;
  });

  unique.sort((a, b) => b._swScore - a._swScore);

  const mode = modeKey(preset);
  const ratio = ratioByMode[mode];
  const targetLiked = Math.round(limit * ratio.liked);
  const targetHeard = Math.round(limit * ratio.heard);
  const targetNovel = Math.max(0, limit - targetLiked - targetHeard);

  const novel = unique.filter((t) => !t._isLiked && !t._isHeard);
  const heard = unique.filter((t) => !t._isLiked && t._isHeard);
  const liked = unique.filter((t) => t._isLiked);

  const picked: RankedTrack[] = [];
  const pickedUrns = new Set<string>();
  const artistCounts = new Map<string, number>();
  const maxPerArtist = mode === 'discover' ? 2 : 3;

  const takeFrom = (pool: RankedTrack[], amount: number) => {
    if (amount <= 0) return;
    let added = 0;
    for (const track of pool) {
      if (picked.length >= limit) return;
      if (pickedUrns.has(track.urn)) continue;
      const artist = artistKey(track);
      const artistCount = artistCounts.get(artist) || 0;
      if (artistCount >= maxPerArtist) continue;
      picked.push(track);
      pickedUrns.add(track.urn);
      artistCounts.set(artist, artistCount + 1);
      added += 1;
      if (added >= amount) {
        return;
      }
    }
  };

  takeFrom(novel, targetNovel);
  takeFrom(heard, targetHeard);
  takeFrom(liked, targetLiked);

  const fallbackPool = [...novel, ...heard, ...liked].sort((a, b) => b._swScore - a._swScore);
  for (const track of fallbackPool) {
    if (picked.length >= limit) break;
    if (pickedUrns.has(track.urn)) continue;
    const artist = artistKey(track);
    const artistCount = artistCounts.get(artist) || 0;
    if (artistCount >= maxPerArtist + 1) continue;
    picked.push(track);
    pickedUrns.add(track.urn);
    artistCounts.set(artist, artistCount + 1);
  }

  return picked;
};

const finalizeCandidates = async (
  candidates: RankedTrack[],
  preset: SoundWavePreset | null,
  limit = 20,
): Promise<Track[]> => {
  if (candidates.length === 0) return [];

  const preselected = selectBalancedTracks(candidates, preset, Math.max(limit + 12, 30));
  const reranked = await rerankIfEnabled(preselected, preset);
  const order = new Map(reranked.map((track, index) => [track.urn, index]));

  const rescored = preselected.map((track) => {
    const rank = order.has(track.urn) ? (order.get(track.urn) as number) : preselected.length;
    return {
      ...track,
      _swScore: track._swScore + (preselected.length - rank) * 0.02,
    } as RankedTrack;
  });

  return selectBalancedTracks(rescored, preset, limit).map((track) => track as Track);
};

interface SoundWaveState {
  isActive: boolean;
  isInitialLoading: boolean;
  currentPreset: SoundWavePreset | null;
  seedTracks: Track[];
  explorePool: Track[];
  genreWeights: Record<string, number>;
  artistWeights: Record<string, number>;
  playedUrns: Set<string>;
  heardUrns: Set<string>;
  heardUrnRank: Map<string, number>;
  sessionPositive: (number | number[])[];
  sessionNegative: (number | number[])[];
  qdrant: QdrantClient | null;
  detectedLanguages: TrackLanguageProfile[];
  languageProfilesMap: Map<number, TrackLanguageProfile>;

  init: () => Promise<void>;
  start: (preset: SoundWavePreset) => Promise<void>;
  stop: () => void;
  generateBatch: () => Promise<Track[]>;
  recordFeedback: (track: Track, type: 'positive' | 'negative') => void;
  trainTrackMood: (track: Track, mood: MoodLabel) => void;
}

export const useSoundWaveStore = create<SoundWaveState>((set, get) => ({
  isActive: false,
  isInitialLoading: false,
  currentPreset: null,
  seedTracks: [],
  explorePool: [],
  genreWeights: {},
  artistWeights: {},
  playedUrns: new Set(),
  heardUrns: new Set(),
  heardUrnRank: new Map(),
  sessionPositive: [],
  sessionNegative: [],
  qdrant: null,
  detectedLanguages: [],
  languageProfilesMap: new Map(),

  init: async () => {
    if (get().seedTracks.length > 0) return;
    console.log('[SoundWave] Initialization started');
    set({ isInitialLoading: true });
    try {
      const settings = useSettingsStore.getState();
      const auth = useAuthStore.getState();
      const userScope =
        auth.user?.urn || (auth.user?.id ? `id_${auth.user.id}` : auth.sessionId || 'local');
      const scopedCollection = buildScopedCollection(
        settings.qdrantCollection || 'sw_v2',
        userScope,
      );

      if (settings.qdrantEnabled && settings.qdrantUrl) {
        console.log(
          '[SoundWave] Qdrant enabled, connecting to:',
          settings.qdrantUrl,
          'collection:',
          scopedCollection,
        );
        const client = new QdrantClient({
          url: settings.qdrantUrl,
          apiKey: settings.qdrantKey || undefined,
          collection: scopedCollection,
        });
        try {
          await client.initCollection();
          console.log('[SoundWave] Qdrant collection initialized');
          set({ qdrant: client });
        } catch (qe) {
          console.error('[SoundWave] Qdrant init failed, continuing without vector search', qe);
        }
      }

      console.log('[SoundWave] Fetching seed tracks (likes)...');
      let tracks: Track[] = [];
      try {
        tracks = await fetchAllLikedTracks(200);
        tracks = tracks.filter((track) => isTrackPlayable(track));
        console.log(`[SoundWave] Found ${tracks.length} liked tracks`);
      } catch (likesError) {
        console.warn(
          '[SoundWave] Failed to fetch likes, continuing with fallback sources',
          likesError,
        );
      }

      console.log(
        '[SoundWave] Fetching exploration tracks (feed/following/playlists/popular/regional)...',
      );
      const regions = parseRegions(settings.regionalTrendRegions || '');
      const historyPromise = Promise.all([
        api<HistoryResponse>('/history?limit=200&offset=0').catch(() => ({ collection: [] })),
        api<HistoryResponse>('/history?limit=200&offset=200').catch(() => ({ collection: [] })),
      ]).then(([h1, h2]) => [...(h1.collection || []), ...(h2.collection || [])]);

      const regionalPromise = settings.regionalTrendSeed
        ? fetchCrossPlatformRegionalTracks(
            async (query, limit = 6) => {
              const encoded = encodeURIComponent(query);
              const result = await api<{ collection: Track[] }>(
                `/tracks?q=${encoded}&limit=${Math.max(1, Math.min(limit, 12))}`,
              );
              return result.collection || [];
            },
            { regions, maxCandidates: 72, maxResolved: 28 },
          ).catch(() => [] as Track[])
        : Promise.resolve([] as Track[]);
      const globalDiscoveryPromise = fetchGlobalDiscoveryTracks().catch(() => [] as Track[]);

      const [
        feedRes,
        followingRes,
        myPlaylistsRes,
        likedPlaylistsRes,
        popularRes,
        globalDiscoveryTracks,
        regionalTracks,
        historyEntries,
      ] = await Promise.all([
        api<{ collection: FeedItem[] }>('/me/feed?limit=60').catch(() => ({ collection: [] })),
        api<{ collection: Track[] }>('/me/followings/tracks?limit=80').catch(() => ({
          collection: [],
        })),
        api<{ collection: Playlist[] } | Playlist[]>('/me/playlists?limit=80').catch(() => []),
        api<{ collection: Playlist[] } | Playlist[]>('/me/likes/playlists?limit=60').catch(
          () => [],
        ),
        api<{ collection: Track[] }>('/tracks?limit=80&linked_partitioning=true').catch(() => ({
          collection: [],
        })),
        globalDiscoveryPromise,
        regionalPromise,
        historyPromise,
      ]);

      const heardUrnRank = new Map<string, number>();
      for (let i = 0; i < historyEntries.length; i++) {
        const urn = normalizeTrackUrn(historyEntries[i].scTrackId || '');
        if (!urn || heardUrnRank.has(urn)) continue;
        heardUrnRank.set(urn, i);
      }
      const heardUrns = new Set(heardUrnRank.keys());

      const feedTracks = (feedRes.collection || [])
        .map((item) => item.origin)
        .filter((origin) => origin?.urn && origin.user) as Track[];

      const playlistTracks = [
        ...extractPlaylistTracks(myPlaylistsRes),
        ...extractPlaylistTracks(likedPlaylistsRes),
      ];
      console.log(`[SoundWave] Playlist-derived tracks: ${playlistTracks.length}`);

      const likedUrns = new Set(tracks.map((t) => t.urn));
      const exploreMap = new Map<string, Track>();
      console.log(`[SoundWave] Global top/trending tracks: ${globalDiscoveryTracks.length}`);
      console.log(`[SoundWave] Regional cross-platform mapped tracks: ${regionalTracks.length}`);

      [
        ...feedTracks,
        ...(followingRes.collection || []),
        ...playlistTracks,
        ...(popularRes.collection || []),
        ...globalDiscoveryTracks,
        ...regionalTracks,
      ].forEach((track) => {
        if (!isTrackPlayable(track)) return;
        if (likedUrns.has(track.urn)) return;
        if (!exploreMap.has(track.urn)) {
          exploreMap.set(track.urn, track);
        }
      });

      const explorePool = [...exploreMap.values()].slice(0, 220);
      console.log(`[SoundWave] Exploration pool size: ${explorePool.length}`);

      if (tracks.length === 0) {
        console.warn(
          '[SoundWave] No liked tracks found, relying on playlists/feed/following for preferences.',
        );
      }

      const preferenceMap = new Map<string, Track>();
      [...tracks, ...playlistTracks].forEach((track) => {
        if (!track?.urn || !track.user) return;
        if (!preferenceMap.has(track.urn)) preferenceMap.set(track.urn, track);
      });
      const preferenceTracks = [...preferenceMap.values()];

      const genreCounts: Record<string, number> = {};
      const artistCounts: Record<string, number> = {};

      preferenceTracks.forEach((t, idx) => {
        // Newer likes weight more
        const w = 0.3 + 0.7 * Math.exp(-idx / 80);
        const g = t.genre?.toLowerCase().trim();
        if (g) genreCounts[g] = (genreCounts[g] || 0) + w;

        const artist = t.user?.username?.toLowerCase().trim();
        if (artist) artistCounts[artist] = (artistCounts[artist] || 0) + w;
      });

      const maxG = Math.max(1, ...Object.values(genreCounts));
      const genreWeights: Record<string, number> = {};
      for (const [g, c] of Object.entries(genreCounts)) genreWeights[g] = c / maxG;

      const maxA = Math.max(1, ...Object.values(artistCounts));
      const artistWeights: Record<string, number> = {};
      for (const [a, c] of Object.entries(artistCounts)) artistWeights[a] = c / maxA;

      console.log('[SoundWave] Weights calculated, genres:', Object.keys(genreWeights).length);
      set({
        seedTracks: tracks,
        explorePool,
        genreWeights,
        artistWeights,
        heardUrns,
        heardUrnRank,
        isInitialLoading: false,
      });

      // Seed Qdrant in background if available
      const q = get().qdrant;
      if (q && (tracks.length > 0 || explorePool.length > 0)) {
        console.log('[SoundWave] Seeding Qdrant in background...');
        q.upsert([
          ...tracks.map((t) => ({ track: t, features: null, isLiked: true })),
          ...explorePool.map((t) => ({ track: t, features: null, isLiked: false })),
        ]).catch((e) => console.error('[SoundWave] Qdrant seeding failed', e));
      }
    } catch (e) {
      console.error('[SoundWave] Init failed critically', e);
      set({ isInitialLoading: false });
    }
  },

  start: async (preset: SoundWavePreset) => {
    const { init, generateBatch, stop } = get();
    console.log('[SoundWave] Starting preset:', preset.name);
    stop(); // Clear previous session
    await init();

    set({
      isActive: true,
      currentPreset: preset,
      playedUrns: new Set(),
      sessionPositive: [],
      sessionNegative: [],
    });

    try {
      console.log('[SoundWave] Generating first batch...');
      const batch = await generateBatch();
      console.log(`[SoundWave] First batch generated: ${batch.length} tracks`);
      if (batch.length > 0) {
        usePlayerStore.getState().play(batch[0], batch);
      } else {
        console.error('[SoundWave] Failed to generate initial batch');
      }
    } catch (e) {
      console.error('[SoundWave] Start failed', e);
      set({ isActive: false });
    }
  },

  stop: () => {
    console.log('[SoundWave] Stopped');
    set({
      isActive: false,
      currentPreset: null,
      playedUrns: new Set(),
      sessionPositive: [],
      sessionNegative: [],
      detectedLanguages: [],
      languageProfilesMap: new Map(),
    });
  },

  recordFeedback: (track: Track, type: 'positive' | 'negative') => {
    const { qdrant, sessionPositive, sessionNegative } = get();
    if (!qdrant) return;

    const id = qdrant.urnToId(track.urn);
    if (!id) return;

    const features = audioAnalyser.getFeatures(track.urn);

    console.log(`[SoundWave] Recording ${type} feedback for: ${track.title}`);

    if (type === 'positive') {
      if (!sessionPositive.includes(id)) {
        set({ sessionPositive: [...sessionPositive, id].slice(-30) });
      }
    } else {
      if (!sessionNegative.includes(id)) {
        set({ sessionNegative: [...sessionNegative, id].slice(-20) });
      }
    }

    // Index the track as a non-liked point for future recommendations
    qdrant
      .upsert([{ track, features, isLiked: false }])
      .catch((e) => console.error('[SoundWave] Feedback indexing failed', e));
  },

  trainTrackMood: (track: Track, mood: MoodLabel) => {
    const { qdrant, sessionPositive } = get();
    if (!qdrant || !track?.urn) return;

    const id = qdrant.urnToId(track.urn);
    if (!id) return;

    const current = audioAnalyser.getFeatures(track.urn);
    const trainedFeatures = withMoodProfile(current, mood);

    console.log(`[SoundWave] Mood training: ${track.title} -> ${mood}`);

    if (!sessionPositive.includes(id)) {
      set({ sessionPositive: [...sessionPositive, id].slice(-30) });
    }

    qdrant
      .upsert([{ track, features: trainedFeatures, isLiked: false }])
      .catch((e) => console.error('[SoundWave] Mood training indexing failed', e));
  },

  generateBatch: async () => {
    if (inFlightGenerateBatch) {
      return inFlightGenerateBatch;
    }

    const runGenerate = async (): Promise<Track[]> => {
      const {
        seedTracks,
        explorePool,
        genreWeights,
        artistWeights,
        currentPreset,
        playedUrns,
        heardUrns,
        heardUrnRank,
        qdrant,
        sessionPositive,
        sessionNegative,
      } = get();
      if (seedTracks.length === 0 && explorePool.length === 0) {
        console.error('[SoundWave] Cannot generate batch: no seed tracks available');
        return [];
      }

      const dislikedUrns = useDislikesStore.getState().dislikedTrackUrns;
      const likedUrns = new Set(seedTracks.map((t) => t.urn));

      if (qdrant) {
        try {
          console.log('[SoundWave] Generating batch via Qdrant...');
          // Use Qdrant Recommend API
          let positive: (number | number[])[] = [...sessionPositive];
          if (positive.length === 0) {
            // Cold start: discover uses explore pool first, others use liked tracks
            const discoverSelection =
              currentPreset?.mode === 'discover'
                ? [...explorePool].sort(() => Math.random() - 0.5).slice(0, 8)
                : [];
            const likedSelection = [...seedTracks].sort(() => Math.random() - 0.5).slice(0, 10);
            const upsertBatch = [
              ...discoverSelection.map((t) => ({ track: t, features: null, isLiked: false })),
              ...likedSelection.map((t) => ({ track: t, features: null, isLiked: true })),
            ];

            if (upsertBatch.length > 0) {
              await qdrant.upsert(upsertBatch);
            }

            positive = [...discoverSelection, ...likedSelection]
              .map((t: Track) => qdrant.urnToId(t.urn))
              .filter((id) => id > 0);
            console.log('[SoundWave] Using cold-start seeds:', positive.length);
          }

          if (positive.length === 0) {
            throw new Error('No valid positive seeds for Qdrant recommend');
          }

          const discoverNegatives =
            currentPreset?.mode === 'discover' && sessionNegative.length === 0
              ? [...seedTracks]
                  .sort(() => Math.random() - 0.5)
                  .slice(0, 8)
                  .map((t) => qdrant.urnToId(t.urn))
                  .filter((id) => id > 0)
              : [];

          const settings = useSettingsStore.getState();
          const targetVector = qdrant.buildTargetVector({
            mode: currentPreset?.mode,
            tags: currentPreset?.tags,
            regionHints: settings.regionalTrendSeed
              ? parseRegions(settings.regionalTrendRegions || '')
              : [],
          });

          const results = await qdrant.recommendHybrid({
            positive,
            negative: [...sessionNegative, ...discoverNegatives],
            limit: 72,
            targetVector,
          });
          console.log(`[SoundWave] Qdrant returned ${results.length} recommendations`);

          const rankedCandidates = results
            .map((r: QdrantScoredPoint) => {
              const payload = (r?.payload || {}) as Record<string, unknown>;
              const urn = (payload.urn as string) || (r?.id ? `soundcloud:tracks:${r.id}` : '');
              if (!urn) return null;
              const fallbackId = typeof r?.id === 'number' ? r.id : qdrant.urnToId(urn);
              const artist = (payload.artist as string) || 'Unknown Artist';

              const isLiked = likedUrns.has(urn) || Boolean(payload.isLiked);
              const heardRank = heardUrnRank.has(urn) ? (heardUrnRank.get(urn) as number) : -1;
              const isHeard = heardRank >= 0;
              const recency = isHeard ? Math.max(0, 1 - heardRank / 220) : 0;

              if (currentPreset?.mode === 'discover' && isLiked) return null;
              if (currentPreset?.mode === 'discover' && isHeard && heardRank < 120) return null;

              let score = Number(r.score || 0) * 10;
              if (isLiked) {
                score +=
                  currentPreset?.mode === 'favorite'
                    ? 2.6
                    : currentPreset?.mode === 'popular'
                      ? 0.4
                      : -4.8;
              }
              if (isHeard) {
                score -=
                  currentPreset?.mode === 'discover' ? 9 * recency + 1.6 : 4.2 * recency + 0.8;
              } else {
                score += currentPreset?.mode === 'discover' ? 2.8 : 1.2;
              }

              const trackText =
                `${payload.genre || ''} ${payload.tag_list || ''} ${payload.title || ''}`.toLowerCase();
              if (currentPreset?.tags?.length) {
                let matches = 0;
                for (const tag of currentPreset.tags) {
                  if (trackText.includes(tag.toLowerCase())) matches++;
                }
                score += matches * 0.7;
              }

              return {
                id: (payload.id as number) || fallbackId || 0,
                urn,
                title: (payload.title as string) || 'Unknown Track',
                duration: (payload.duration as number) || 210000,
                artwork_url: (payload.artwork_url as string | null) || null,
                genre: (payload.genre as string) || '',
                tag_list: (payload.tag_list as string) || '',
                playback_count: (payload.playback_count as number) || 0,
                likes_count:
                  (payload.likes_count as number) || (payload.favoritings_count as number) || 0,
                favoritings_count:
                  (payload.favoritings_count as number) || (payload.likes_count as number) || 0,
                user: {
                  id: 0,
                  urn: (payload.user_urn as string) || 'soundcloud:users:0',
                  username: artist,
                  avatar_url: (payload.user_avatar_url as string) || '',
                  permalink_url: (payload.user_permalink_url as string) || '',
                },
                isLiked,
                _qdrant: true,
                _swScore: score,
                _isLiked: isLiked,
                _isHeard: isHeard,
                _heardRank: heardRank,
              } as RankedTrack;
            })
            .filter((track): track is RankedTrack => {
              if (!track) return false;
              if (!track.urn) return false;
              if (!isTrackPlayable(track)) return false;
              if (playedUrns.has(track.urn)) return false;
              if (dislikedUrns.includes(track.urn)) return false;
              return true;
            });

          console.log(`[SoundWave] Filtered batch: ${rankedCandidates.length} candidates`);

          if (currentPreset?.mode === 'discover' && rankedCandidates.length < 14) {
            const needed = 14 - rankedCandidates.length;
            const exploreFill = [...explorePool]
              .filter((t) => {
                if (!t.urn) return false;
                if (playedUrns.has(t.urn)) return false;
                if (dislikedUrns.includes(t.urn)) return false;
                if (likedUrns.has(t.urn)) return false;
                const heardRank = heardUrnRank.has(t.urn)
                  ? (heardUrnRank.get(t.urn) as number)
                  : -1;
                return heardRank < 0 || heardRank > 120;
              })
              .sort(() => Math.random() - 0.5)
              .slice(0, needed);

            if (exploreFill.length > 0) {
              console.log(`[SoundWave] Added ${exploreFill.length} explore fallback tracks`);
              rankedCandidates.push(
                ...exploreFill.map(
                  (track) =>
                    ({
                      ...track,
                      _swScore: 5 + Math.random() * 1.5,
                      _isLiked: false,
                      _isHeard: heardUrns.has(track.urn),
                      _heardRank: heardUrnRank.has(track.urn)
                        ? (heardUrnRank.get(track.urn) as number)
                        : -1,
                    }) as RankedTrack,
                ),
              );
            }
          }

          if (rankedCandidates.length > 0) {
            const settings = useSettingsStore.getState();
            let candidatesForFinalize = rankedCandidates;
            let enrichedProfiles: Map<number, TrackLanguageProfile> | null = null;

            if (settings.languageFilterEnabled && settings.preferredLanguage !== 'all') {
              const { filtered: languageScoped, profiles } =
                await applyLanguageFilterWithEnrichment(
                  rankedCandidates,
                  settings.preferredLanguage,
                );
              enrichedProfiles = profiles;
              if (languageScoped.length > 0) {
                console.log(
                  `[SoundWave] Language filter '${settings.preferredLanguage}': ${languageScoped.length}/${rankedCandidates.length} candidates`,
                );
                candidatesForFinalize = languageScoped;
              } else {
                const languageSearchTracks = await fetchLanguageSearchTracks(
                  settings.preferredLanguage,
                );
                const fallbackSource = [...languageSearchTracks, ...explorePool, ...seedTracks]
                  .filter(
                    (t) =>
                      isTrackPlayable(t) && !playedUrns.has(t.urn) && !dislikedUrns.includes(t.urn),
                  )
                  .slice(0, 520);

                const { filtered: languageFallback, profiles: fallbackProfiles } =
                  await applyLanguageFilterWithEnrichment(
                    fallbackSource,
                    settings.preferredLanguage,
                  );

                if (languageFallback.length > 0) {
                  console.warn(
                    `[SoundWave] Qdrant has 0 '${settings.preferredLanguage}' candidates, using language fallback pool: ${languageFallback.length}`,
                  );
                  candidatesForFinalize = languageFallback.map((track) => {
                    const heardRank = heardUrnRank.has(track.urn)
                      ? (heardUrnRank.get(track.urn) as number)
                      : -1;
                    return {
                      ...track,
                      _swScore: 4.5 + Math.random() * 1.2,
                      _isLiked: likedUrns.has(track.urn) || Boolean(track.user_favorite),
                      _isHeard: heardRank >= 0,
                      _heardRank: heardRank,
                    } as RankedTrack;
                  });
                  enrichedProfiles = fallbackProfiles;
                } else {
                  console.warn(
                    `[SoundWave] No '${settings.preferredLanguage}' tracks found even in fallback pool`,
                  );
                  return [];
                }
              }
            }

            const finalTracks = await finalizeCandidates(candidatesForFinalize, currentPreset, 20);

            for (const t of finalTracks) {
              playedUrns.add(t.urn);
            }

            const languageProfiles = finalTracks.map(
              (t) => enrichedProfiles?.get(t.id) || analyzeTrackLanguage(t),
            );
            const existingProfiles = get().detectedLanguages;
            const existingIds = new Set(existingProfiles.map((p) => p.trackId));
            const newProfiles = languageProfiles.filter((p) => !existingIds.has(p.trackId));
            if (newProfiles.length > 0) {
              const updatedProfiles = [...existingProfiles, ...newProfiles].slice(-200);
              const profilesMap = new Map<number, TrackLanguageProfile>();
              for (const p of updatedProfiles) {
                profilesMap.set(p.trackId, p);
              }
              set({ detectedLanguages: updatedProfiles, languageProfilesMap: profilesMap });
            }

            return finalTracks;
          }

          console.warn(
            '[SoundWave] Qdrant produced no usable tracks, falling back to legacy algorithm',
          );
        } catch (e) {
          console.error('[SoundWave] Qdrant recommend failed, falling back to legacy algorithm', e);
        }
      }

      console.log('[SoundWave] Generating batch via Legacy Algorithm...');

      // Fallback to legacy algorithm...

      // Pick 5 random seeds from user's likes
      const seedBase =
        currentPreset?.mode === 'discover' && explorePool.length > 0 ? explorePool : seedTracks;
      if (seedBase.length === 0) {
        return [];
      }
      const seeds = [...seedBase].sort(() => Math.random() - 0.5).slice(0, 5);
      const candidates: RankedTrack[] = [];
      const seenUrns = new Set<string>();

      // Step 1: Fetch related tracks for each seed
      const results = await Promise.all(
        seeds.map((s) =>
          api<{ collection: Track[] }>(`/tracks/${encodeURIComponent(s.urn)}/related?limit=20`)
            .then((res) => res.collection || [])
            .catch(() => []),
        ),
      );

      // Step 2: Scoring
      const flat = results.flat();

      for (const track of flat) {
        if (
          !track.urn ||
          seenUrns.has(track.urn) ||
          playedUrns.has(track.urn) ||
          dislikedUrns.includes(track.urn)
        )
          continue;
        seenUrns.add(track.urn);

        let score = 0;
        const genre = track.genre?.toLowerCase().trim();
        const artist = track.user?.username?.toLowerCase().trim();
        const isLiked = likedUrns.has(track.urn) || Boolean(track.user_favorite);
        const heardRank = heardUrnRank.has(track.urn)
          ? (heardUrnRank.get(track.urn) as number)
          : -1;
        const isHeard = heardRank >= 0;
        const recency = isHeard ? Math.max(0, 1 - heardRank / 240) : 0;

        if (currentPreset?.mode === 'discover' && isLiked) {
          continue;
        }

        if (currentPreset?.mode === 'discover' && isHeard && heardRank < 140) {
          continue;
        }

        // Affinity scores
        if (currentPreset?.mode === 'discover') {
          const gw = genre && genreWeights[genre] ? genreWeights[genre] : 0;
          const aw = artist && artistWeights[artist] ? artistWeights[artist] : 0;
          score += (1 - gw) * 4;
          score += aw > 0 ? -aw * 6 : 1.5;
        } else {
          if (genre && genreWeights[genre]) score += genreWeights[genre] * 5;
          if (artist && artistWeights[artist]) score += artistWeights[artist] * 3;
          if (currentPreset?.mode !== 'favorite' && isLiked) score -= 8;
        }

        if (isHeard) {
          score -= currentPreset?.mode === 'discover' ? 14 * recency + 4 : 5 * recency + 1.2;
        } else {
          score += currentPreset?.mode === 'discover' ? 3.2 : 1.1;
        }

        // Preset matching
        if (currentPreset?.tags) {
          const trackText =
            `${track.genre} ${track.tag_list} ${track.title} ${track.description}`.toLowerCase();
          let matchCount = 0;
          for (const tag of currentPreset.tags) {
            if (trackText.includes(tag.toLowerCase())) matchCount++;
          }
          score += matchCount * 4;
        }

        // Mode adjustments
        const plays = track.playback_count || 0;
        if (currentPreset?.mode === 'popular') {
          score += Math.min(10, plays / 100000);
          const createdAtTs = track.created_at ? Date.parse(track.created_at) : Number.NaN;
          if (Number.isFinite(createdAtTs)) {
            const ageDays = (Date.now() - createdAtTs) / (1000 * 60 * 60 * 24);
            if (ageDays <= 45) score += 4.5;
            else if (ageDays <= 90) score += 2.2;
          }
        } else if (currentPreset?.mode === 'discover') {
          if (plays < 5000) score += 10;
          else if (plays < 50000) score += 5;
          else score -= 5;
        }

        // Penalty for "Type Beats"
        if (/\b(free|type\s*beat|instrumental|prod|минус|бит)\b/i.test(track.title || '')) {
          score -= 15;
        }

        candidates.push({
          ...track,
          _swScore: score + Math.random() * 0.08,
          _isLiked: isLiked,
          _isHeard: isHeard,
          _heardRank: heardRank,
        });
      }

      const settings = useSettingsStore.getState();
      let candidatesForFinalize = candidates;
      let enrichedProfiles: Map<number, TrackLanguageProfile> | null = null;

      if (settings.languageFilterEnabled && settings.preferredLanguage !== 'all') {
        const { filtered: languageScoped, profiles } = await applyLanguageFilterWithEnrichment(
          candidates,
          settings.preferredLanguage,
        );
        enrichedProfiles = profiles;
        if (languageScoped.length > 0) {
          console.log(
            `[SoundWave] Language filter '${settings.preferredLanguage}': ${languageScoped.length}/${candidates.length} candidates`,
          );
          candidatesForFinalize = languageScoped;
        } else {
          const languageSearchTracks = await fetchLanguageSearchTracks(settings.preferredLanguage);
          const fallbackSource = [...languageSearchTracks, ...explorePool, ...seedTracks]
            .filter(
              (t) => isTrackPlayable(t) && !playedUrns.has(t.urn) && !dislikedUrns.includes(t.urn),
            )
            .slice(0, 520);

          const { filtered: languageFallback, profiles: fallbackProfiles } =
            await applyLanguageFilterWithEnrichment(fallbackSource, settings.preferredLanguage);

          if (languageFallback.length > 0) {
            console.warn(
              `[SoundWave] Legacy has 0 '${settings.preferredLanguage}' candidates, using language fallback pool: ${languageFallback.length}`,
            );
            candidatesForFinalize = languageFallback.map((track) => {
              const heardRank = heardUrnRank.has(track.urn)
                ? (heardUrnRank.get(track.urn) as number)
                : -1;
              return {
                ...track,
                _swScore: 4.2 + Math.random() * 1.1,
                _isLiked: likedUrns.has(track.urn) || Boolean(track.user_favorite),
                _isHeard: heardRank >= 0,
                _heardRank: heardRank,
              } as RankedTrack;
            });
            enrichedProfiles = fallbackProfiles;
          } else {
            console.warn(
              `[SoundWave] No '${settings.preferredLanguage}' tracks found even in fallback pool`,
            );
            return [];
          }
        }
      }

      const selected = await finalizeCandidates(candidatesForFinalize, currentPreset, 20);

      for (const t of selected) {
        playedUrns.add(t.urn);
      }

      const languageProfiles = selected.map(
        (t) => enrichedProfiles?.get(t.id) || analyzeTrackLanguage(t),
      );
      const existingProfiles = get().detectedLanguages;
      const existingIds = new Set(existingProfiles.map((p) => p.trackId));
      const newProfiles = languageProfiles.filter((p) => !existingIds.has(p.trackId));
      if (newProfiles.length > 0) {
        const updatedProfiles = [...existingProfiles, ...newProfiles].slice(-200);
        const profilesMap = new Map<number, TrackLanguageProfile>();
        for (const p of updatedProfiles) {
          profilesMap.set(p.trackId, p);
        }
        set({ detectedLanguages: updatedProfiles, languageProfilesMap: profilesMap });
      }

      return selected;
    };

    inFlightGenerateBatch = runGenerate()
      .catch((error) => {
        console.error('[SoundWave] generateBatch failed', error);
        return [];
      })
      .finally(() => {
        inFlightGenerateBatch = null;
      });

    return inFlightGenerateBatch;
  },
}));
