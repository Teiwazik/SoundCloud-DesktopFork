import { invoke } from '@tauri-apps/api/core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import Fuse from 'fuse.js';
import { saveLyricsToCache, loadLyricsFromCache } from './cache';
import { api, ApiError, streamUrl } from './api';
import { isTauriRuntime } from './runtime';

const LRCLIB_API = 'https://lrclib.net/api';
const LYRICS_OVH_API = 'https://api.lyrics.ovh/v1';
const NCM_API = 'https://ncm.nekohasegawa.com';
const TEXTYL_API = 'https://api.textyl.co/api/lyrics';
const MUSIXMATCH_API = 'https://apic-desktop.musixmatch.com/ws/1.1';
const KROKO_ASR_URL = '';
const TIMEOUT_MS = 10000;
const ASR_TIMEOUT_MS = TIMEOUT_MS;
const ENABLE_NCM = (import.meta.env.VITE_LYRICS_NCM || '').toLowerCase() === 'true';
const ENABLE_QWEN_ASR = false;
const ENABLE_KROKO_ASR = false;
const DEV_LYRICS_DEBUG = import.meta.env.DEV;
const LYRICS_MISS_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_TITLE_ONLY_ATTEMPTS = 6;
const MAX_PRIORITY_TITLE_ONLY_ATTEMPTS = 3;
// Bump to drop stale cache entries after title-variant search changes.
const LYRICS_SEARCH_CACHE_VERSION = 14;
export const LYRICS_SEARCH_QUERY_VERSION = 15;
const LYRIC_PAUSE_MARKER = '♪♪♪';
const PAUSE_SECTION_LINE_REGEX =
  /^(?:instrumental|interlude|solo|guitar solo|drum solo|проигрыш|проигрыши|инструментал|соло)(?:\s+(?:x|х|×)?\d+)?$/iu;
export interface LyricLine {
  time: number;
  text: string;
}

interface PreparedLyricLine {
  text: string;
  isPause: boolean;
}

export type LyricsSource =
  | 'soundcloud'
  | 'lrclib'
  | 'netease'
  | 'musixmatch'
  | 'genius'
  | 'textyl'
  | 'kroko'
  | 'qwen'
  | 'vosk';

export interface LyricsResult {
  plain: string | null;
  synced: LyricLine[] | null;
  source: LyricsSource;
}

export interface LyricsSearchOptions {
  uploaderUsername?: string;
  originalTitle?: string;
  durationMs?: number;
  genre?: string | null;
  tagList?: string | null;
  description?: string | null;
  createdAt?: string | null;
  artworkUrl?: string | null;
  forceRefresh?: boolean;
}

export interface TimedCommentLike {
  id: number | string;
  body: string;
  timestamp: number | null;
}

export interface LyricMotionHint {
  index: number;
  time: number;
  importance: number;
  density: number;
  onsetBias: number;
  language: 'ru' | 'en' | 'mixed' | 'other';
}

let musixmatchTokenPromise: Promise<string | null> | null = null;
const lyricMotionHintCache = new Map<string, LyricMotionHint[]>();
const lyricsMissCache = new Map<string, number>();
const REQUIRED_TITLE_IDENTITY_TOKENS = new Set(['aac', 'flac', 'm4a', 'mp3', 'ogg', 'opus', 'wav']);
const TITLE_HINT_NOISE_PREFIXES = [
  'acoustic',
  'audio',
  'clean',
  'edit',
  'explicit',
  'feat',
  'featuring',
  'ft',
  'instrumental',
  'intro',
  'live',
  'lyrics',
  'official',
  'outro',
  'prod',
  'produced',
  'radio',
  'remix',
  'skit',
  'slowed',
  'snippet',
  'sped up',
  'speed up',
  'video',
];
const REUPLOAD_NOISE_PATTERNS = [
  /\breupload\b/gi,
  /\bnot\s+my\s+(?:music|song|track|audio)\b/gi,
  /\bfree\s+dl\b/gi,
  /\bhq\b/gi,
  /\b\d{3,4}p\b/gi,
  /\bno\s+copyright\b/gi,
  /\[(?:repost|upload|dl|hq|free|oc)\]/gi,
];
const DERIVATIVE_VERSION_PATTERNS = [
  /\bslowed(?:\s*\+\s*reverb)?\b/gi,
  /\breverb(?:ed)?\b/gi,
  /\bnightcore\b/gi,
  /\bsped\s*up\b/gi,
  /\blofi\b/gi,
  /\bpitched\s*(?:up|down)\b/gi,
  /\bbass\s*boost(?:ed)?\b/gi,
];
const PRODUCER_TAG_PATTERNS = [
  /\bp[./]\s*[\p{L}\p{N}_.\s-]+/giu,
  /\bprod\.?\s+by\s+[\p{L}\p{N}_.\s-]+/giu,
  /\bprod[./]\s*[\p{L}\p{N}_.\s-]+/giu,
  /\([\p{L}\p{N}_.\s-]+\s+on\s+the\s+beat\)/giu,
];
const EXTRA_TITLE_NOISE_PATTERNS = [
  /\bsnippet\b/gi,
  /\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/g,
  /\b\d{4}[-./]\d{1,2}[-./]\d{1,2}\b/g,
  /\*+$/g,
  /\b(?:official\s+)?(?:audio|video|lyrics?\s+video|visualizer|lyric\s+video)\b/gi,
  /\bofficial\b/gi,
  /\blyrics?\b/gi,
];

function logLyricsDebug(message: string, details?: unknown) {
  if (!DEV_LYRICS_DEBUG) return;
  if (details === undefined) {
    console.log(`[Lyrics] ${message}`);
    return;
  }
  console.log(`[Lyrics] ${message}`, details);
}

function warnLyricsDebug(message: string, details?: unknown) {
  if (!DEV_LYRICS_DEBUG) return;
  if (details === undefined) {
    console.warn(`[Lyrics] ${message}`);
    return;
  }
  console.warn(`[Lyrics] ${message}`, details);
}

function buildLyricsMissCacheKey(trackUrn: string, artist: string, title: string): string {
  const normalizedUrn = String(trackUrn || '').trim();
  if (normalizedUrn) return `v${LYRICS_SEARCH_QUERY_VERSION}:urn:${normalizedUrn}`;
  return `v${LYRICS_SEARCH_QUERY_VERSION}:query:${normalizeSearchText(artist)}::${normalizeSearchText(title)}`;
}

function pruneLyricsMissCache(now = Date.now()) {
  for (const [key, expiresAt] of lyricsMissCache) {
    if (expiresAt <= now) {
      lyricsMissCache.delete(key);
    }
  }
}

export function isQwenAsrEnabled(): boolean {
  return false;
}

export function isKrokoAsrEnabled(): boolean {
  return false;
}

export function isAnyAsrEnabled(): boolean {
  return false;
}

export function getPreferredAsrProviderName(): string {
  return 'Sync';
}

function normalizeLyricsResult(result: LyricsResult | null): LyricsResult | null {
  if (!result) return null;

  const plain = typeof result.plain === 'string' ? normalizePlainLyricsText(result.plain) : null;
  const synced = normalizeSyncedLyrics(result.synced);

  if (!plain && !synced) return null;
  return {
    ...result,
    plain,
    synced,
  };
}

function cleanGeniusLyricsText(value: string): string {
  return (
    normalizePlainLyricsText(
      value
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\d+\s*Contributors/i, '')
        .replace(/^[^\n]*?Lyrics/i, '')
        .replace(/^\[Текст песни.*?\]/i, '')
        .replace(/\b(?:\d+\s*)?Embed\s*$/i, ''),
    ) || ''
  );
}

function decodeHtmlToText(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  return doc.body?.textContent || '';
}

const LRC_TIMESTAMP_TAG_REGEX = /\[([^\]\r\n]+)\]/g;

function normalizeLyricsTextBlock(value: string): string {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/^\d+\s*Contributors/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeLyricLineText(value: string): string {
  return normalizeLyricsTextBlock(value).replace(/\n+/g, ' ').trim();
}

function isLyricsPlaceholderText(value: string): boolean {
  const normalized = normalizeLyricsTextBlock(value).toLowerCase();
  if (!normalized) return true;
  return /(?:lyrics?\s+(?:not available|unavailable|coming soon|not found)|we.?re working on|instrumental)/i.test(
    normalized,
  );
}

function isLikelyLyricsBoilerplateLine(value: string): boolean {
  const trimmed = normalizeLyricLineText(value);
  if (!trimmed) return true;

  if (
    /^(?:\d+\s*)?contributors?(?:\s+\w+){0,4}$/i.test(trimmed) ||
    /^(?:translations?|romanizations?|lyrics|embed|copy|share|share url|read more)$/i.test(
      trimmed,
    ) ||
    /^(?:you might also like|advertisement|original lyrics)$/i.test(trimmed) ||
    /^see .* live$/i.test(trimmed) ||
    /^translated by\b/i.test(trimmed) ||
    /^submitted by\b/i.test(trimmed)
  ) {
    return true;
  }

  return (
    /\bcontributors?\b/i.test(trimmed) && /\b(translations?|romanizations?|lyrics)\b/i.test(trimmed)
  );
}

function normalizePlainLyricsText(value: string): string | null {
  let normalized = String(value ?? '');

  if (/<[a-z][\s\S]*>/i.test(normalized)) {
    normalized = decodeLyricsHtmlWithBreaks(normalized);
  }

  normalized = normalizeLyricsTextBlock(normalized);
  if (!normalized || isLyricsPlaceholderText(normalized)) return null;

  const cleanedLines: string[] = [];
  for (const rawLine of normalized.split('\n')) {
    const line = normalizeLyricLineText(rawLine);
    if (!line) {
      if (cleanedLines.length > 0 && cleanedLines[cleanedLines.length - 1] !== '') {
        cleanedLines.push('');
      }
      continue;
    }
    if (isLikelyLyricsBoilerplateLine(line)) continue;
    cleanedLines.push(line);
  }

  while (cleanedLines[0] === '') cleanedLines.shift();
  while (cleanedLines[cleanedLines.length - 1] === '') cleanedLines.pop();

  const plain = cleanedLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return plain && !isLyricsPlaceholderText(plain) ? plain : null;
}

const DESCRIPTION_SECTION_HEADER_REGEX =
  /^\s*(?:\[[^\]]+\]|\((?:куплет|припев|бридж|verse|chorus|bridge|hook|outro|intro)[^)]+\))\s*$/imu;
const DESCRIPTION_PROMO_MARKER_REGEX =
  /\b(?:prod(?:uced)?\s+by|booking|bookings|follow|subscribe|pre[- ]?save|presave|out\s+now|stream\s+now|available\s+on|all\s+platforms|snippet|demo|cover\s+art|mix(?:ed)?\s+by|master(?:ed)?\s+by)\b/giu;
const DESCRIPTION_LINK_REGEX = /(?:https?:\/\/\S+|(?:^|\s)t\.me\/\S+|(?:^|\s)vk\.com\/\S+)/giu;

function hasRepeatedDescriptionPhrase(value: string): boolean {
  const tokens = normalizeSearchText(value)
    .split(' ')
    .filter((token) => token.length >= 2);
  if (tokens.length < 24) return false;

  const counts = new Map<string, number>();
  for (let index = 0; index <= tokens.length - 4; index += 1) {
    const gramTokens = tokens.slice(index, index + 4);
    if (gramTokens.some((token) => token.length < 2)) continue;
    const gram = gramTokens.join(' ');
    const next = (counts.get(gram) ?? 0) + 1;
    if (next >= 2) return true;
    counts.set(gram, next);
  }

  return false;
}

function normalizeDescriptionLyricsText(value: string): string | null {
  const raw = normalizeLyricsTextBlock(value);
  if (!raw) return null;

  const linkMatches = raw.match(DESCRIPTION_LINK_REGEX) || [];
  let normalized = raw
    .replace(DESCRIPTION_LINK_REGEX, ' ')
    .replace(/(?:^|\n)\s*(?:tg|тг|telegram|телега)\.?\s*[:\-]?\s*/giu, '\n')
    .replace(/(?:^|\n)\s*@[\p{L}\p{N}_]{3,32}\s*$/gimu, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const lines = normalized
    .split('\n')
    .map((line) => normalizeLyricLineText(line))
    .filter(Boolean);

  while (
    lines.length > 0 &&
    (lines[0].length <= 40 || /^(?:tg|тг|telegram|телега|link|links)$/iu.test(lines[0]))
  ) {
    lines.shift();
  }

  normalized = lines.join('\n').trim();
  if (!normalized) return null;

  const promoHits = normalized.match(DESCRIPTION_PROMO_MARKER_REGEX)?.length ?? 0;
  const wordCount = normalizeSearchText(normalized).split(' ').filter(Boolean).length;
  const lineCount = normalized.split('\n').filter(Boolean).length;
  const hasSectionHeaders = DESCRIPTION_SECTION_HEADER_REGEX.test(normalized);
  const repeatedPhrase = hasRepeatedDescriptionPhrase(normalized);

  if (promoHits >= 3) return null;
  if (linkMatches.length > 2) return null;
  if (wordCount < 28 || normalized.length < 150) return null;

  if (!hasSectionHeaders && lineCount < 4 && !repeatedPhrase) {
    return null;
  }

  return normalizePlainLyricsText(normalized);
}

function normalizeLyricTimeNumber(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  let time = Number(value);
  if (time > 10000) time /= 1000;
  if (!Number.isFinite(time) || time < 0 || time > 60 * 60 * 3) return null;
  return time;
}

function parseTimestampFraction(value: string | null | undefined): number {
  const fraction = String(value || '').replace(/[^\d]/g, '');
  if (!fraction) return 0;
  return Number(fraction.slice(0, 3).padEnd(3, '0')) / 1000;
}

function parseLooseTimestamp(value: string): number | null {
  const trimmed = String(value || '')
    .trim()
    .replace(/^\[|\]$/g, '');
  if (!trimmed) return null;

  if (/^\d+(?:[.,]\d+)?$/.test(trimmed)) {
    return normalizeLyricTimeNumber(Number(trimmed.replace(',', '.')));
  }

  const minuteSecondFraction = trimmed.match(/^(\d{1,3}):(\d{1,2}):(\d{1,3})$/);
  if (minuteSecondFraction) {
    const [, minutes, seconds, fraction] = minuteSecondFraction;
    if (Number(seconds) < 60) {
      return normalizeLyricTimeNumber(
        Number(minutes) * 60 + Number(seconds) + parseTimestampFraction(fraction),
      );
    }
  }

  const hourMinuteSecond = trimmed.match(/^(\d{1,2}):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (hourMinuteSecond) {
    const [, hours, minutes, seconds, fraction] = hourMinuteSecond;
    if (Number(minutes) < 60 && Number(seconds) < 60) {
      return normalizeLyricTimeNumber(
        Number(hours) * 3600 +
          Number(minutes) * 60 +
          Number(seconds) +
          parseTimestampFraction(fraction),
      );
    }
  }

  const minuteSecond = trimmed.match(/^(\d{1,3}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (minuteSecond) {
    const [, minutes, seconds, fraction] = minuteSecond;
    if (Number(seconds) < 60) {
      return normalizeLyricTimeNumber(
        Number(minutes) * 60 + Number(seconds) + parseTimestampFraction(fraction),
      );
    }
  }

  return null;
}

function extractTimeCandidate(value: unknown): number | null {
  if (value == null) return null;

  if (typeof value === 'number') {
    return normalizeLyricTimeNumber(value);
  }

  if (typeof value === 'string') {
    return parseLooseTimestamp(value);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = extractTimeCandidate(item);
      if (parsed != null) return parsed;
    }
    return null;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const candidate of [
      record.total,
      record.time,
      record.start,
      record.start_time,
      record.startTime,
      record.seconds,
      record.sec,
      record.milliseconds,
      record.ms,
      record.offset,
      record.begin,
      record.value,
    ]) {
      const parsed = extractTimeCandidate(candidate);
      if (parsed != null) return parsed;
    }
  }

  return null;
}

function extractLyricTextCandidate(value: unknown): string | null {
  if (typeof value === 'string') {
    return /<[a-z][\s\S]*>/i.test(value)
      ? normalizeLyricLineText(decodeLyricsHtmlWithBreaks(value))
      : normalizeLyricLineText(value);
  }

  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return normalizeLyricLineText(value.join(' '));
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const candidate of [
      record.text,
      record.lyrics,
      record.line,
      record.content,
      record.transcript,
      record.subtitle,
      record.caption,
      record.body,
      record.value,
      record.label,
      record.html,
    ]) {
      const extracted = extractLyricTextCandidate(candidate);
      if (extracted) return extracted;
    }
  }

  return null;
}

function extractLyricTimeFromRecord(entry: Record<string, unknown>): number | null {
  for (const candidate of [
    entry.timestamp,
    entry.time,
    entry.start,
    entry.start_time,
    entry.startTime,
    entry.offset,
    entry.t,
    entry.begin,
    entry.seconds,
    entry.sec,
    entry.position,
    entry.milliseconds,
    entry.ms,
    entry.total,
  ]) {
    const parsed = extractTimeCandidate(candidate);
    if (parsed != null) return parsed;
  }

  return null;
}

function normalizeSyncedLyrics(lines: LyricLine[] | null | undefined): LyricLine[] | null {
  if (!Array.isArray(lines) || lines.length === 0) return null;

  const prepared = lines
    .map((line) => ({
      time: normalizeLyricTimeNumber(Number(line?.time)),
      text: normalizeSyncedLyricLineText(String(line?.text || '')),
    }))
    .filter((line): line is LyricLine => line.time != null && Boolean(line.text))
    .filter((line) => !isLikelyLyricsBoilerplateLine(line.text))
    .sort((a, b) => a.time - b.time);

  if (prepared.length === 0) return null;

  const normalized: LyricLine[] = [];
  for (const line of prepared) {
    const previous = normalized[normalized.length - 1];
    if (previous) {
      if (Math.abs(previous.time - line.time) < 0.05) {
        if (previous.text === line.text) continue;
        if (!previous.text.includes(line.text) && !line.text.includes(previous.text)) {
          previous.text = `${previous.text}\n${line.text}`;
        }
        continue;
      }

      if (previous.text === line.text && line.time - previous.time < 0.65) continue;

      if (line.time <= previous.time) {
        line.time = previous.time + 0.02;
      }
    }

    normalized.push(line);
  }

  return normalized.length > 0 ? normalized : null;
}

function scorePlainLyricsCandidate(value: string): number {
  const plain = normalizePlainLyricsText(value);
  if (!plain) return 0;

  const lines = plain.split('\n').filter(Boolean);
  const sectionHeaders = lines.filter((line) => isSectionHeader(line)).length;

  return (
    Math.min(lines.length * 4, 80) +
    Math.min(plain.length / 24, 40) +
    (/\[\d{1,3}:\d{1,2}/.test(value) ? 18 : 0) -
    sectionHeaders * 2
  );
}

function scoreSyncedLyricsCandidate(lines: LyricLine[] | null | undefined): number {
  if (!lines?.length) return 0;

  let score = Math.min(lines.length * 5, 120);
  let monotonic = true;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].time <= lines[i - 1].time) {
      monotonic = false;
      break;
    }
  }
  if (monotonic) score += 18;
  if (lines[0].time <= 5) score += 8;
  return score;
}

function parseMaybeJson(value: string): unknown | null {
  const trimmed = String(value || '').trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function isLyricsPayloadKey(key: string): boolean {
  return /lyric|lyrics|lrc|subtitle|caption|transcript|segment|line|body|content|html|text/i.test(
    key,
  );
}

function collectLyricStringCandidates(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
  keyHint = '',
): string[] {
  if (depth > 4 || value == null) return [];

  if (typeof value === 'string') {
    return keyHint && !isLyricsPayloadKey(keyHint) && depth > 0 ? [] : [value];
  }

  if (typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);

  if (Array.isArray(value)) {
    const candidates = value.every((item) => typeof item === 'string') ? [value.join('\n')] : [];
    for (const item of value.slice(0, 24)) {
      candidates.push(...collectLyricStringCandidates(item, depth + 1, seen, keyHint));
    }
    return candidates;
  }

  const record = value as Record<string, unknown>;
  const prioritizedKeys = [
    'lyrics',
    'lyric',
    'plainLyrics',
    'plain',
    'syncedLyrics',
    'lrc',
    'subtitle_body',
    'subtitle',
    'subtitles',
    'body',
    'html',
    'text',
    'content',
    'transcript',
    'lines',
    'segments',
    'captions',
    'data',
    'result',
  ];

  const candidates: string[] = [];
  for (const key of prioritizedKeys) {
    if (key in record) {
      candidates.push(...collectLyricStringCandidates(record[key], depth + 1, seen, key));
    }
  }

  for (const [key, nestedValue] of Object.entries(record).slice(0, 24)) {
    if (prioritizedKeys.includes(key)) continue;
    if (depth > 0 && !isLyricsPayloadKey(key)) continue;
    candidates.push(...collectLyricStringCandidates(nestedValue, depth + 1, seen, key));
  }

  return candidates;
}

function collectLyricArrayCandidates(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
  keyHint = '',
): unknown[][] {
  if (depth > 4 || value == null || typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);

  if (Array.isArray(value)) {
    const candidates =
      value.length > 0 && (keyHint === '' || isLyricsPayloadKey(keyHint)) ? [value] : [];
    for (const item of value.slice(0, 24)) {
      candidates.push(...collectLyricArrayCandidates(item, depth + 1, seen, keyHint));
    }
    return candidates;
  }

  const record = value as Record<string, unknown>;
  const candidates: unknown[][] = [];
  for (const [key, nestedValue] of Object.entries(record).slice(0, 24)) {
    if (depth > 0 && !isLyricsPayloadKey(key) && !['data', 'result'].includes(key)) continue;
    candidates.push(...collectLyricArrayCandidates(nestedValue, depth + 1, seen, key));
  }
  return candidates;
}

function parseInlineTimedLyricLine(raw: string): LyricLine | null {
  const trimmed = normalizeLyricsTextBlock(raw);
  if (!trimmed) return null;

  const match = trimmed.match(
    /^(?:\[)?(\d{1,3}:\d{1,2}(?:(?:[.,:]\d{1,3})|:\d{1,2}(?:[.,]\d{1,3})?)?)(?:\])?\s*(.+)$/,
  );
  if (!match) return null;

  const time = parseLooseTimestamp(match[1]);
  const text = normalizeLyricLineText(match[2]);
  if (time == null || !text) return null;
  return { time, text };
}

function parseLyricLineArrayCandidate(items: unknown[]): LyricLine[] | null {
  if (items.length === 0) return null;

  if (items.every((item) => typeof item === 'string')) {
    const joined = items.join('\n');
    const parsedLrc = parseLRC(joined);
    if (parsedLrc.length > 0) return parsedLrc;

    const parsedInline = items
      .map((item) => parseInlineTimedLyricLine(String(item)))
      .filter((line): line is LyricLine => Boolean(line));
    return normalizeSyncedLyrics(parsedInline);
  }

  const lines: LyricLine[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const text = extractLyricTextCandidate(entry);
    const time = extractLyricTimeFromRecord(entry);
    if (!text || time == null) continue;
    lines.push({ time, text });
  }

  return normalizeSyncedLyrics(lines);
}

function buildPlainLyricsFromSynced(lines: LyricLine[] | null | undefined): string | null {
  if (!lines?.length) return null;
  return normalizePlainLyricsText(lines.map((line) => line.text).join('\n'));
}

function extractSyncedLyricsFromUnknown(value: unknown): LyricLine[] | null {
  const candidates: LyricLine[][] = [];

  if (typeof value === 'string') {
    const json = parseMaybeJson(value);
    if (json) {
      const fromJson = extractSyncedLyricsFromUnknown(json);
      if (fromJson) candidates.push(fromJson);
    }

    const parsedLrc = parseLRC(value);
    if (parsedLrc.length > 0) candidates.push(parsedLrc);
  }

  if (value && typeof value === 'object') {
    for (const arrayCandidate of collectLyricArrayCandidates(value)) {
      const parsed = parseLyricLineArrayCandidate(arrayCandidate);
      if (parsed?.length) candidates.push(parsed);
    }

    for (const stringCandidate of collectLyricStringCandidates(value)) {
      const parsed = parseLRC(stringCandidate);
      if (parsed.length > 0) candidates.push(parsed);
    }
  }

  let best: LyricLine[] | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const normalized = normalizeSyncedLyrics(candidate);
    const score = scoreSyncedLyricsCandidate(normalized);
    if (normalized && score > bestScore) {
      best = normalized;
      bestScore = score;
    }
  }

  return best;
}

function extractPlainLyricsFromUnknown(value: unknown): string | null {
  const candidates: string[] = [];

  if (typeof value === 'string') {
    const json = parseMaybeJson(value);
    if (json) {
      const fromJson = extractPlainLyricsFromUnknown(json);
      if (fromJson) candidates.push(fromJson);
    }

    if (/<[a-z][\s\S]*>/i.test(value) && /data-lyrics-container|lyricsData/i.test(value)) {
      const genius = extractGeniusLyricsFromHtml(value);
      if (genius) candidates.push(genius);
    }

    const fromLrc = buildPlainLyricsFromSynced(parseLRC(value));
    if (fromLrc) candidates.push(fromLrc);
    candidates.push(value);
  } else if (value && typeof value === 'object') {
    for (const stringCandidate of collectLyricStringCandidates(value)) {
      const fromLrc = buildPlainLyricsFromSynced(parseLRC(stringCandidate));
      if (fromLrc) candidates.push(fromLrc);
      candidates.push(stringCandidate);
    }
  }

  let best: string | null = null;
  let bestScore = 0;
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const normalized = normalizePlainLyricsText(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    const score = scorePlainLyricsCandidate(normalized);
    if (score > bestScore) {
      best = normalized;
      bestScore = score;
    }
  }

  return best;
}

function decodeLyricsHtmlWithBreaks(html: string): string {
  return decodeHtmlToText(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:div|p|section|article|li|blockquote|h[1-6])>/gi, '\n'),
  );
}

function extractGeniusLyricsFromContainer(container: Element): string {
  const clone = container.cloneNode(true) as Element;
  clone
    .querySelectorAll('[data-exclude-from-selection="true"], script, style')
    .forEach((node) => node.remove());
  return cleanGeniusLyricsText(decodeLyricsHtmlWithBreaks(clone.innerHTML));
}

function extractLegacyGeniusLyricsFromHtml(html: string): string | null {
  const scriptMatch = html.match(/"lyricsData":\s*(\{[\s\S]*?\})\s*,\s*"album"/);
  if (scriptMatch?.[1]) {
    try {
      const payload = JSON.parse(scriptMatch[1]);
      const body = payload?.body?.html || payload?.lyrics?.body?.html || '';
      const plain = cleanGeniusLyricsText(decodeLyricsHtmlWithBreaks(String(body)));
      if (plain.length > 20) return plain;
    } catch {
      // fall back to container parsing
    }
  }

  const containerMatches = [
    ...html.matchAll(/<div[^>]*data-lyrics-container\s*=\s*["']true["'][^>]*>([\s\S]*?)<\/div>/gi),
  ];
  if (containerMatches.length > 0) {
    const plain = cleanGeniusLyricsText(
      decodeLyricsHtmlWithBreaks(containerMatches.map((match) => match[1] || '').join('\n')),
    );
    if (plain.length > 20) return plain;
  }

  return null;
}

function extractGeniusLyricsFromHtml(html: string): string | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const containers = Array.from(doc.querySelectorAll('div[data-lyrics-container="true"]'));

  if (containers.length > 0) {
    const plain = cleanGeniusLyricsText(
      containers
        .map((container) => extractGeniusLyricsFromContainer(container))
        .filter((chunk) => chunk.length > 0)
        .join('\n\n'),
    );
    if (plain.length > 20) return plain;
  }

  return extractLegacyGeniusLyricsFromHtml(html);
}

async function firstNonNull<T>(tasks: Array<() => Promise<T | null>>): Promise<T | null> {
  if (tasks.length === 0) return null;

  return await new Promise<T | null>((resolve) => {
    let pending = tasks.length;
    let settled = false;

    const markDone = () => {
      pending -= 1;
      if (!settled && pending <= 0) {
        settled = true;
        resolve(null);
      }
    };

    for (const task of tasks) {
      void task()
        .then((result) => {
          if (settled) return;
          if (result) {
            settled = true;
            resolve(result);
            return;
          }
          markDone();
        })
        .catch(() => {
          if (settled) return;
          markDone();
        });
    }
  });
}

async function requestText(url: string, signal?: AbortSignal): Promise<string> {
  const isGeniusRequest = /^https:\/\/(?:www\.)?genius\.com\//i.test(url);
  const headers = isGeniusRequest
    ? {
        Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
        Referer: 'https://genius.com/',
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
      }
    : undefined;
  const res = isTauriRuntime()
    ? await tauriFetch(url, { method: 'GET', signal, headers })
    : await fetch(url, { signal, headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

async function requestJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  return JSON.parse(await requestText(url, signal)) as T;
}

async function getMusixmatchToken(signal: AbortSignal): Promise<string | null> {
  if (!musixmatchTokenPromise) {
    musixmatchTokenPromise = (async () => {
      try {
        const data = await requestJson<{
          message?: {
            body?: {
              user_token?: string;
            };
          };
        }>(`${MUSIXMATCH_API}/token.get?app_id=web-desktop-app-v1.0`, signal);

        return data?.message?.body?.user_token || null;
      } catch {
        return null;
      }
    })();
  }

  return musixmatchTokenPromise;
}

function parseMusixmatchSubtitleBody(subtitleBody: string | null | undefined): LyricLine[] | null {
  return subtitleBody ? extractSyncedLyricsFromUnknown(subtitleBody) : null;
}

function normalizeLyricText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSectionHeader(value: string): boolean {
  const trimmed = value.trim();
  return /^\[[^\]]+\]$/.test(trimmed);
}

function isExplicitPauseSectionLine(value: string): boolean {
  return PAUSE_SECTION_LINE_REGEX.test(normalizeLyricText(value));
}

function isPauseMarkerLine(value: string): boolean {
  const trimmed = normalizeLyricsTextBlock(value).trim();
  if (!trimmed || trimmed === '...' || trimmed === LYRIC_PAUSE_MARKER) return true;
  return isExplicitPauseSectionLine(trimmed);
}

function normalizeSyncedLyricLineText(value: string): string {
  const normalized = normalizeLyricLineText(value);
  if (normalized) {
    return isPauseMarkerLine(normalized) ? LYRIC_PAUSE_MARKER : normalized;
  }
  return isPauseMarkerLine(value) ? LYRIC_PAUSE_MARKER : '';
}

function buildPreparedLyricLines(plainLyrics: string): PreparedLyricLine[] {
  const prepared: PreparedLyricLine[] = [];
  const pushPause = () => {
    if (prepared[prepared.length - 1]?.isPause) return;
    prepared.push({ text: LYRIC_PAUSE_MARKER, isPause: true });
  };

  for (const rawLine of String(plainLyrics || '').split(/\r?\n/)) {
    const trimmed = normalizeLyricsTextBlock(rawLine).trim();

    if (!trimmed) {
      pushPause();
      continue;
    }

    if (isSectionHeader(trimmed)) {
      if (isExplicitPauseSectionLine(trimmed)) {
        pushPause();
      }
      continue;
    }

    if (isPauseMarkerLine(trimmed)) {
      pushPause();
      continue;
    }

    const text = normalizeLyricLineText(trimmed);
    if (!text) {
      pushPause();
      continue;
    }

    prepared.push({ text, isPause: false });
  }

  while (prepared[0]?.isPause) prepared.shift();
  while (prepared[prepared.length - 1]?.isPause) prepared.pop();

  return prepared;
}

function tokenizeNormalizedText(value: string): string[] {
  return value.split(' ').filter(Boolean);
}

function countVowels(value: string): number {
  const matches = value.match(/[aeiouyаеёиоуыэюя]/gi);
  return matches?.length ?? 0;
}

function lineWeight(value: string): number {
  const normalized = normalizeLyricText(value);
  if (!normalized) return 1;
  const tokens = tokenizeNormalizedText(normalized);
  return Math.max(tokens.length + countVowels(normalized) * 0.12, 1);
}

function getPreparedLyricLineWeight(line: PreparedLyricLine): number {
  return line.isPause ? 0.72 : lineWeight(line.text);
}

function estimateLyricLeadDurationSec(text: string): number {
  const normalized = normalizeLyricText(text);
  if (!normalized) return 0.78;

  const tokens = tokenizeNormalizedText(normalized);
  const vowels = countVowels(normalized);
  const punctuationTail = /[,.!?…:;]$/.test(text.trim()) ? 0.12 : 0;
  const densityBoost = Math.min(tokens.length * 0.09 + vowels * 0.018, 0.72);

  return Math.max(0.68, Math.min(3.2, 0.62 + densityBoost + punctuationTail));
}

function tightenAutoSyncedLineStarts(lines: LyricLine[], trackDurationSec?: number): LyricLine[] {
  if (lines.length < 2) return lines;

  const tightened = lines.map((line) => ({ ...line })).sort((a, b) => a.time - b.time);

  const firstIdeal = Math.max(
    0,
    tightened[1].time - estimateLyricLeadDurationSec(tightened[0].text),
  );
  if (tightened[0].time > firstIdeal + 0.12) {
    const lateBy = tightened[0].time - firstIdeal;
    tightened[0].time = Math.max(0, firstIdeal + Math.min(lateBy * 0.28, 0.26));
  }

  for (let i = 1; i < tightened.length; i++) {
    const previous = tightened[i - 1];
    const current = tightened[i];
    const minStart = previous.time + 0.14;
    const predictedStart = previous.time + estimateLyricLeadDurationSec(previous.text);

    if (current.time > predictedStart + 0.18) {
      const lag = current.time - predictedStart;
      current.time = Math.max(minStart, predictedStart + Math.min(lag * 0.32, 0.34));
    } else {
      current.time = Math.max(minStart, current.time);
    }
  }

  if (trackDurationSec && Number.isFinite(trackDurationSec)) {
    const maxLastStart = Math.max(trackDurationSec - 0.18, 0);
    tightened[tightened.length - 1].time = Math.min(
      tightened[tightened.length - 1].time,
      maxLastStart,
    );
  }

  return tightened;
}

function detectLyricLanguage(value: string): 'ru' | 'en' | 'mixed' | 'other' {
  const cyr = (value.match(/[а-яё]/gi) || []).length;
  const lat = (value.match(/[a-z]/gi) || []).length;
  if (cyr > 0 && lat > 0) return 'mixed';
  if (cyr > 0) return 'ru';
  if (lat > 0) return 'en';
  return 'other';
}

function getLyricLineDensity(text: string): number {
  const normalized = normalizeLyricText(text);
  if (!normalized) return 0;
  const tokens = tokenizeNormalizedText(normalized);
  const vowels = countVowels(normalized);
  return Math.max(tokens.length * 0.65 + vowels * 0.22, 0.35);
}

function getLyricLineImportance(text: string): number {
  const normalized = normalizeLyricText(text);
  if (!normalized) return 0;
  const language = detectLyricLanguage(normalized);
  const tokens = tokenizeNormalizedText(normalized);
  const vowelCount = countVowels(normalized);
  const repeatedChars = /(.)\1{2,}/u.test(normalized) ? 0.14 : 0;
  const emphaticWord =
    /\b(yeah|hey|go|drop|bass|love|heart|night|fire|я|ты|мы|эй|оу|любов|сердц|ноч|огонь|бей)\b/iu.test(
      normalized,
    )
      ? 0.16
      : 0;
  const languageBoost = language === 'ru' || language === 'en' || language === 'mixed' ? 0.08 : 0;
  return Math.min(
    1.75,
    tokens.length * 0.12 + vowelCount * 0.045 + repeatedChars + emphaticWord + languageBoost,
  );
}

function getLyricOnsetBias(text: string): number {
  const normalized = normalizeLyricText(text);
  if (!normalized) return 0;
  const vowelCount = countVowels(normalized);
  const hardEdges = (normalized.match(/[бпдткгfvszжшчц]/giu) || []).length;
  const syllablePulses = (normalized.match(/(?:[аеёиоуыэюяaeiouy]{1,2})/giu) || []).length;
  return Math.min(1, vowelCount * 0.08 + hardEdges * 0.03 + syllablePulses * 0.04);
}

function tokenOverlapScore(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const aSet = new Set(a);
  const bSet = new Set(b);
  let intersection = 0;
  for (const token of aSet) {
    if (bSet.has(token)) intersection++;
  }
  const union = new Set([...aSet, ...bSet]).size;
  return union > 0 ? intersection / union : 0;
}

function orderedTokenScore(commentTokens: string[], lineTokens: string[]): number {
  if (commentTokens.length === 0 || lineTokens.length === 0) return 0;
  let cursor = 0;
  let matched = 0;
  for (const token of commentTokens) {
    const foundAt = lineTokens.indexOf(token, cursor);
    if (foundAt >= 0) {
      matched++;
      cursor = foundAt + 1;
    }
  }
  return matched / commentTokens.length;
}

function textSimilarityScore(comment: string, line: string): number {
  const commentNormalized = normalizeLyricText(comment);
  const lineNormalized = normalizeLyricText(line);
  if (!commentNormalized || !lineNormalized) return 0;

  const commentTokens = tokenizeNormalizedText(commentNormalized);
  const lineTokens = tokenizeNormalizedText(lineNormalized);
  if (commentTokens.length === 0 || lineTokens.length === 0) return 0;

  const overlap = tokenOverlapScore(commentTokens, lineTokens);
  const ordered = orderedTokenScore(commentTokens, lineTokens);
  const substringBoost =
    lineNormalized.includes(commentNormalized) || commentNormalized.includes(lineNormalized)
      ? 1
      : 0;
  const density = Math.min(commentTokens.length / Math.max(lineTokens.length, 1), 1);

  return overlap * 0.45 + ordered * 0.35 + substringBoost * 0.15 + density * 0.05;
}

function getNextSameNormalizedIndex(
  lyricMeta: Array<{ text: string; normalized: string }>,
  fromIndex: number,
): number | null {
  const base = lyricMeta[fromIndex]?.normalized;
  if (!base) return null;
  for (let i = fromIndex + 1; i < lyricMeta.length; i++) {
    if (lyricMeta[i].normalized === base) return i;
  }
  return null;
}

function getLeadInWindowSec(firstAnchorTimeSec: number, leadLineCount: number): number {
  if (leadLineCount <= 0) return 0;
  if (firstAnchorTimeSec <= 1.4) return firstAnchorTimeSec;
  return Math.min(
    Math.max(leadLineCount * 1.25, 2.6),
    Math.max(3.2, Math.min(firstAnchorTimeSec * 0.34, 9.5)),
  );
}

export function buildPseudoSyncedLyrics(
  plainLyrics: string,
  comments: TimedCommentLike[],
  trackDurationSec?: number,
): LyricLine[] | null {
  const preparedLines = buildPreparedLyricLines(plainLyrics);
  const lyricMeta = preparedLines
    .map((line, preparedIndex) =>
      line.isPause
        ? null
        : {
            preparedIndex,
            text: line.text,
            normalized: normalizeLyricText(line.text),
          },
    )
    .filter(
      (line): line is { preparedIndex: number; text: string; normalized: string } =>
        line != null && line.text.trim().length >= 2,
    );
  if (lyricMeta.length < 4) return null;

  const preparedComments = comments
    .filter((comment) => comment.timestamp != null)
    .map((comment) => ({
      id: comment.id,
      timeSec: Number(comment.timestamp) / 1000,
      raw: comment.body,
      normalized: normalizeLyricText(comment.body),
    }))
    .filter((comment) => comment.timeSec >= 0 && comment.normalized.length >= 6)
    .sort((a, b) => a.timeSec - b.timeSec);

  if (preparedComments.length < 2) return null;

  const anchors: Array<{
    metaIndex: number;
    preparedIndex: number;
    timeSec: number;
    score: number;
  }> = [];
  let minMetaIndex = 0;

  for (const comment of preparedComments) {
    let best: { metaIndex: number; score: number } | null = null;

    for (let i = minMetaIndex; i < lyricMeta.length; i++) {
      const score = textSimilarityScore(comment.raw, lyricMeta[i].text);
      if (score < 0.42) continue;
      const duplicateIndex = getNextSameNormalizedIndex(lyricMeta, i);
      const duplicateBias = duplicateIndex != null && duplicateIndex - i <= 5 ? 0.035 : 0;
      const distancePenalty: number = best ? Math.max(0, (i - minMetaIndex - 10) * 0.01) : 0;
      const total: number = score - distancePenalty - duplicateBias;
      if (!best || total > best.score) {
        best = { metaIndex: i, score: total };
      }
    }

    if (!best) continue;

    const previous = anchors[anchors.length - 1];
    if (previous) {
      if (best.metaIndex < previous.metaIndex) continue;
      if (comment.timeSec <= previous.timeSec + 0.35 && best.metaIndex > previous.metaIndex)
        continue;
      if (best.metaIndex === previous.metaIndex && best.score <= previous.score) continue;

      if (best.metaIndex === previous.metaIndex) {
        const nextSameIndex = getNextSameNormalizedIndex(lyricMeta, previous.metaIndex);
        if (
          nextSameIndex != null &&
          nextSameIndex <= previous.metaIndex + 4 &&
          comment.timeSec > previous.timeSec + 1.6
        ) {
          anchors.push({
            metaIndex: nextSameIndex,
            preparedIndex: lyricMeta[nextSameIndex].preparedIndex,
            timeSec: comment.timeSec,
            score: best.score - 0.01,
          });
          minMetaIndex = nextSameIndex;
          continue;
        }
        previous.timeSec = comment.timeSec;
        previous.score = best.score;
        continue;
      }

      const previousText = lyricMeta[previous.metaIndex]?.normalized;
      const bestText = lyricMeta[best.metaIndex]?.normalized;
      if (bestText && previousText === bestText && comment.timeSec > previous.timeSec + 1.4) {
        const nextSameIndex = getNextSameNormalizedIndex(lyricMeta, previous.metaIndex);
        if (nextSameIndex != null && nextSameIndex <= best.metaIndex) {
          anchors.push({
            metaIndex: nextSameIndex,
            preparedIndex: lyricMeta[nextSameIndex].preparedIndex,
            timeSec: comment.timeSec,
            score: best.score - 0.015,
          });
          minMetaIndex = nextSameIndex;
          continue;
        }
      }
    }

    anchors.push({
      metaIndex: best.metaIndex,
      preparedIndex: lyricMeta[best.metaIndex].preparedIndex,
      timeSec: comment.timeSec,
      score: best.score,
    });
    minMetaIndex = best.metaIndex;
  }

  const dedupedAnchors = anchors.filter((anchor, index) => {
    const prev = anchors[index - 1];
    if (!prev) return true;
    if (anchor.metaIndex === prev.metaIndex && anchor.timeSec <= prev.timeSec + 0.55) return false;
    return true;
  });

  if (dedupedAnchors.length < 2) return null;

  dedupedAnchors.sort((a, b) => a.timeSec - b.timeSec || a.metaIndex - b.metaIndex);

  const anchorsForTiming = dedupedAnchors;

  if (anchorsForTiming.length < 2) return null;

  const lineTimes = new Array<number>(preparedLines.length).fill(NaN);
  for (const anchor of anchorsForTiming) {
    lineTimes[anchor.preparedIndex] = anchor.timeSec;
  }

  const distributeRange = (
    startLine: number,
    startTime: number,
    endLine: number,
    endTime: number,
  ) => {
    if (endLine <= startLine) return;
    const segmentLines = preparedLines.slice(startLine, endLine + 1);
    const weights = segmentLines.map(getPreparedLyricLineWeight);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || segmentLines.length;
    let acc = startTime;
    lineTimes[startLine] = startTime;
    for (let i = startLine + 1; i <= endLine; i++) {
      const share =
        weights.slice(0, i - startLine).reduce((sum, weight) => sum + weight, 0) / totalWeight;
      const interpolated = startTime + (endTime - startTime) * share;
      acc = Math.max(acc + 0.12, interpolated);
      lineTimes[i] = Math.min(acc, endTime);
    }
    lineTimes[endLine] = endTime;
  };

  for (let i = 0; i < anchorsForTiming.length - 1; i++) {
    const current = anchorsForTiming[i];
    const next = anchorsForTiming[i + 1];
    distributeRange(current.preparedIndex, current.timeSec, next.preparedIndex, next.timeSec);
  }

  const firstAnchor = anchorsForTiming[0];
  const leadInWindowSec = getLeadInWindowSec(firstAnchor.timeSec, firstAnchor.preparedIndex);
  const leadStartTime = Math.max(0, firstAnchor.timeSec - leadInWindowSec);
  if (firstAnchor.preparedIndex === 0) {
    lineTimes[0] = Math.max(firstAnchor.timeSec, leadStartTime);
  } else {
    distributeRange(0, leadStartTime, firstAnchor.preparedIndex, firstAnchor.timeSec);
  }

  const effectiveDuration =
    trackDurationSec && Number.isFinite(trackDurationSec)
      ? Math.max(trackDurationSec, anchorsForTiming[anchorsForTiming.length - 1].timeSec + 2)
      : anchorsForTiming[anchorsForTiming.length - 1].timeSec +
        Math.max(
          preparedLines.length - anchorsForTiming[anchorsForTiming.length - 1].preparedIndex,
          2,
        ) *
          2.4;

  const lastAnchor = anchorsForTiming[anchorsForTiming.length - 1];
  let tailTime = lineTimes[lastAnchor.preparedIndex];
  for (let i = lastAnchor.preparedIndex + 1; i < preparedLines.length; i++) {
    tailTime += Math.max(0.8, getPreparedLyricLineWeight(preparedLines[i]) * 0.42);
    lineTimes[i] = Math.min(tailTime, Math.max(effectiveDuration - 0.35, 0));
  }

  const pseudoSynced = preparedLines.map((line, index) => ({
    time: Number.isFinite(lineTimes[index]) ? lineTimes[index] : index * 2.5,
    text: line.isPause ? LYRIC_PAUSE_MARKER : line.text,
  }));

  pseudoSynced.sort((a, b) => a.time - b.time);

  for (let i = 1; i < pseudoSynced.length; i++) {
    if (pseudoSynced[i].time <= pseudoSynced[i - 1].time) {
      pseudoSynced[i].time = pseudoSynced[i - 1].time + 0.12;
    }
  }

  return tightenAutoSyncedLineStarts(pseudoSynced, trackDurationSec);
}

export function buildPseudoSyncedLyricsFromResult(
  lyrics: LyricsResult | null,
  comments: TimedCommentLike[],
  trackDurationMs?: number,
): LyricsResult | null {
  if (!lyrics || lyrics.synced || !lyrics.plain) return lyrics;
  const pseudoSynced = buildPseudoSyncedLyrics(
    lyrics.plain,
    comments,
    trackDurationMs != null ? trackDurationMs / 1000 : undefined,
  );
  if (!pseudoSynced) return lyrics;
  return {
    ...lyrics,
    synced: pseudoSynced,
  };
}

interface AsrWordTiming {
  start: number;
  end: number;
  text: string;
}

function tryParseJsonString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function normalizeAsrWordTimings(words: AsrWordTiming[]): AsrWordTiming[] {
  const prepared = words
    .map((word) => ({
      start: Number.isFinite(word.start) ? Math.max(0, word.start) : NaN,
      end: Number.isFinite(word.end) ? Math.max(word.start, word.end) : word.start,
      text: String(word.text || '').trim(),
    }))
    .filter((word) => Number.isFinite(word.start) && word.text.length > 0)
    .sort((a, b) => a.start - b.start);

  for (let i = 1; i < prepared.length; i++) {
    if (prepared[i].start <= prepared[i - 1].start) {
      prepared[i].start = prepared[i - 1].start + 0.02;
    }
    if (prepared[i].end < prepared[i].start) {
      prepared[i].end = prepared[i].start;
    }
  }

  return prepared;
}

function extractVoskWords(payload: unknown): AsrWordTiming[] | null {
  const nestedCandidates: unknown[] = [payload];

  const words: AsrWordTiming[] = [];
  const visited = new Set<unknown>();
  const pushWord = (entry: Record<string, unknown>) => {
    const textValue = entry.word ?? entry.text ?? entry.token ?? entry.value ?? '';
    const text = String(textValue).trim();
    const start = toFiniteNumber(
      entry.start ??
        entry.startTime ??
        entry.start_time ??
        (Array.isArray(entry.timestamp) ? entry.timestamp[0] : undefined),
    );
    const end = toFiniteNumber(
      entry.end ??
        entry.endTime ??
        entry.end_time ??
        (Array.isArray(entry.timestamp) ? entry.timestamp[1] : undefined),
    );
    if (!text || start == null) return;
    words.push({ start: normalizeKrokoTime(start), end: normalizeKrokoTime(end ?? start), text });
  };

  const visit = (candidate: unknown) => {
    const parsedCandidate = tryParseJsonString(candidate);
    if (!parsedCandidate || typeof parsedCandidate !== 'object') return;
    if (visited.has(parsedCandidate)) return;
    visited.add(parsedCandidate);

    if (Array.isArray(parsedCandidate)) {
      for (const item of parsedCandidate) {
        visit(item);
      }
      return;
    }

    const entry = parsedCandidate as Record<string, unknown>;
    pushWord(entry);

    const nextNodes: unknown[] = [
      entry.result,
      entry.words,
      entry.data,
      entry.segments,
      entry.alternatives,
      entry.response,
      entry.payload,
      entry.message,
      entry.final,
      entry.partial,
    ];

    for (const next of nextNodes) {
      if (next == null) continue;
      visit(next);
    }

    if (Array.isArray(entry.alternatives)) {
      for (const alternative of entry.alternatives) {
        visit(alternative);
      }
    }
  };

  for (const candidate of nestedCandidates) {
    visit(candidate);
  }

  const normalized = normalizeAsrWordTimings(words);
  return normalized.length > 0 ? normalized : null;
}

function summarizePayloadForDebug(payload: unknown): unknown {
  const parsed = tryParseJsonString(payload);
  if (parsed == null) return { kind: 'nullish' };
  if (typeof parsed === 'string') {
    return { kind: 'string', preview: parsed.slice(0, 200) };
  }
  if (Array.isArray(parsed)) {
    return { kind: 'array', length: parsed.length, first: parsed[0] ?? null };
  }
  if (typeof parsed === 'object') {
    const entry = parsed as Record<string, unknown>;
    return {
      kind: 'object',
      keys: Object.keys(entry),
      resultKind: Array.isArray(entry.result)
        ? `array:${entry.result.length}`
        : typeof entry.result,
      wordsKind: Array.isArray(entry.words) ? `array:${entry.words.length}` : typeof entry.words,
      alternativesKind: Array.isArray(entry.alternatives)
        ? `array:${entry.alternatives.length}`
        : typeof entry.alternatives,
      text: typeof entry.text === 'string' ? entry.text.slice(0, 180) : undefined,
      partial: typeof entry.partial === 'string' ? entry.partial.slice(0, 180) : undefined,
      messageKind: typeof entry.message,
    };
  }
  return { kind: typeof parsed };
}

function buildSyncedLyricsFromWordTimings(
  plainLyrics: string,
  words: AsrWordTiming[],
  trackDurationSec?: number,
): LyricLine[] | null {
  const preparedLines = buildPreparedLyricLines(plainLyrics);
  const lyricMeta = preparedLines
    .map((line, preparedIndex) =>
      line.isPause
        ? null
        : {
            preparedIndex,
            text: line.text,
            normalized: normalizeLyricText(line.text),
          },
    )
    .filter(
      (line): line is { preparedIndex: number; text: string; normalized: string } =>
        line != null && line.text.trim().length >= 2,
    );
  if (lyricMeta.length < 4 || words.length < 4) return null;

  const anchors: Array<{ preparedIndex: number; timeSec: number; score: number }> = [];
  let cursor = 0;

  for (let metaIndex = 0; metaIndex < lyricMeta.length && cursor < words.length; metaIndex++) {
    const line = lyricMeta[metaIndex];
    const lineTokens = tokenizeNormalizedText(line.normalized);
    if (lineTokens.length === 0) continue;

    let best: { start: number; end: number; score: number } | null = null;
    const startLimit = Math.min(words.length - 1, cursor + 28);

    for (let start = cursor; start <= startLimit; start++) {
      const maxWindow = Math.min(words.length, start + Math.max(4, lineTokens.length + 8));
      let windowText = '';

      for (let end = start; end < maxWindow; end++) {
        windowText = windowText ? `${windowText} ${words[end].text}` : words[end].text;
        if (end === start) continue;

        const rawScore = textSimilarityScore(windowText, line.text);
        const lengthPenalty = Math.abs(end - start + 1 - lineTokens.length) * 0.012;
        const total = rawScore - lengthPenalty;

        if (!best || total > best.score) {
          best = { start, end: end + 1, score: total };
        }
      }
    }

    const threshold = lineTokens.length <= 2 ? 0.56 : 0.45;
    if (!best || best.score < threshold) continue;

    anchors.push({
      preparedIndex: line.preparedIndex,
      timeSec: words[best.start].start,
      score: best.score,
    });
    cursor = Math.max(best.end, cursor + 1);
  }

  if (anchors.length < 2) return null;

  const lineTimes = new Array<number>(preparedLines.length).fill(NaN);
  for (const anchor of anchors) {
    lineTimes[anchor.preparedIndex] = anchor.timeSec;
  }

  const distributeRange = (
    startLine: number,
    startTime: number,
    endLine: number,
    endTime: number,
  ) => {
    if (endLine <= startLine) return;
    const segmentLines = preparedLines.slice(startLine, endLine + 1);
    const weights = segmentLines.map(getPreparedLyricLineWeight);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || segmentLines.length;
    let acc = startTime;
    lineTimes[startLine] = startTime;
    for (let i = startLine + 1; i <= endLine; i++) {
      const share =
        weights.slice(0, i - startLine).reduce((sum, weight) => sum + weight, 0) / totalWeight;
      const interpolated = startTime + (endTime - startTime) * share;
      acc = Math.max(acc + 0.12, interpolated);
      lineTimes[i] = Math.min(acc, endTime);
    }
    lineTimes[endLine] = endTime;
  };

  for (let i = 0; i < anchors.length - 1; i++) {
    const current = anchors[i];
    const next = anchors[i + 1];
    distributeRange(current.preparedIndex, current.timeSec, next.preparedIndex, next.timeSec);
  }

  const firstAnchor = anchors[0];
  const leadInWindowSec = getLeadInWindowSec(firstAnchor.timeSec, firstAnchor.preparedIndex);
  const leadStartTime = Math.max(0, firstAnchor.timeSec - leadInWindowSec);
  if (firstAnchor.preparedIndex === 0) {
    lineTimes[0] = Math.max(firstAnchor.timeSec, leadStartTime);
  } else {
    distributeRange(0, leadStartTime, firstAnchor.preparedIndex, firstAnchor.timeSec);
  }

  const lastAnchor = anchors[anchors.length - 1];
  const effectiveDuration =
    trackDurationSec && Number.isFinite(trackDurationSec)
      ? Math.max(trackDurationSec, lastAnchor.timeSec + 2)
      : Math.max(
          words[words.length - 1]?.end ?? lastAnchor.timeSec + 2.4,
          lastAnchor.timeSec + 2.4,
        );

  let tailTime = lineTimes[lastAnchor.preparedIndex];
  for (let i = lastAnchor.preparedIndex + 1; i < preparedLines.length; i++) {
    tailTime += Math.max(0.8, getPreparedLyricLineWeight(preparedLines[i]) * 0.42);
    lineTimes[i] = Math.min(tailTime, Math.max(effectiveDuration - 0.35, 0));
  }

  const synced = preparedLines.map((line, index) => ({
    time: Number.isFinite(lineTimes[index]) ? lineTimes[index] : index * 2.5,
    text: line.isPause ? LYRIC_PAUSE_MARKER : line.text,
  }));

  synced.sort((a, b) => a.time - b.time);
  for (let i = 1; i < synced.length; i++) {
    if (synced[i].time <= synced[i - 1].time) {
      synced[i].time = synced[i - 1].time + 0.12;
    }
  }

  return synced;
}

function buildWeightedSyncedLyricsFallback(
  plainLyrics: string,
  words: AsrWordTiming[],
  trackDurationSec?: number,
): LyricLine[] | null {
  const preparedLines = buildPreparedLyricLines(plainLyrics);
  const voicedLineCount = preparedLines.filter((line) => !line.isPause).length;
  if (voicedLineCount < 2 || words.length < 2) return null;

  const totalWeight =
    preparedLines.reduce((sum, line) => sum + getPreparedLyricLineWeight(line), 0) ||
    preparedLines.length;
  const trackStart = Math.max(0, words[0]?.start ?? 0);
  const trackEndFromWords = Math.max(
    words[words.length - 1]?.end ?? trackStart + 1,
    trackStart + 1,
  );
  const trackEnd =
    trackDurationSec && Number.isFinite(trackDurationSec)
      ? Math.max(trackDurationSec - 0.2, trackEndFromWords)
      : trackEndFromWords;
  const totalSpan = Math.max(trackEnd - trackStart, preparedLines.length * 0.35);

  let accWeight = 0;
  const synced = preparedLines.map((line, index) => {
    const time = index === 0 ? trackStart : trackStart + (totalSpan * accWeight) / totalWeight;
    accWeight += getPreparedLyricLineWeight(line);
    return { time, text: line.isPause ? LYRIC_PAUSE_MARKER : line.text };
  });

  for (let i = 1; i < synced.length; i++) {
    if (synced[i].time <= synced[i - 1].time + 0.1) {
      synced[i].time = synced[i - 1].time + 0.12;
    }
  }

  return tightenAutoSyncedLineStarts(synced, trackDurationSec);
}

function buildDurationOnlySyncedLyrics(
  plainLyrics: string,
  trackDurationSec?: number,
): LyricLine[] | null {
  const preparedLines = buildPreparedLyricLines(plainLyrics);
  const voicedLineCount = preparedLines.filter((line) => !line.isPause).length;
  if (voicedLineCount < 2) return null;

  const totalWeight =
    preparedLines.reduce((sum, line) => sum + getPreparedLyricLineWeight(line), 0) ||
    preparedLines.length;
  const totalSpan =
    trackDurationSec && Number.isFinite(trackDurationSec)
      ? Math.max(trackDurationSec - 0.2, preparedLines.length * 1.2)
      : Math.max(preparedLines.length * 2.35, 6);

  let accWeight = 0;
  const synced = preparedLines.map((line, index) => {
    const time = index === 0 ? 0 : (totalSpan * accWeight) / totalWeight;
    accWeight += getPreparedLyricLineWeight(line);
    return { time, text: line.isPause ? LYRIC_PAUSE_MARKER : line.text };
  });

  for (let i = 1; i < synced.length; i++) {
    if (synced[i].time <= synced[i - 1].time + 0.1) {
      synced[i].time = synced[i - 1].time + 0.12;
    }
  }

  return tightenAutoSyncedLineStarts(synced, trackDurationSec);
}

function getRecognizedCoverageScore(plainLyrics: string, words: AsrWordTiming[]): number {
  if (!plainLyrics || words.length === 0) return 0;
  const recognizedText = words.map((word) => word.text).join(' ');
  const normalizedRecognized = normalizeLyricText(recognizedText);
  const normalizedLyrics = normalizeLyricText(plainLyrics);
  if (!normalizedRecognized || !normalizedLyrics) return 0;

  const recognizedTokens = tokenizeNormalizedText(normalizedRecognized);
  const lyricTokens = tokenizeNormalizedText(normalizedLyrics);
  if (recognizedTokens.length === 0 || lyricTokens.length === 0) return 0;

  const overlap = tokenOverlapScore(recognizedTokens, lyricTokens);
  const density = Math.min(recognizedTokens.length / lyricTokens.length, 1);
  return overlap * 0.7 + density * 0.3;
}

export async function resolveLyricsAutoSyncFromCommentsOrAsr(
  _trackUrn: string,
  lyrics: LyricsResult | null,
  comments: TimedCommentLike[],
  _artist: string,
  _title: string,
  allowCommentAutoSync = true,
  trackDurationMs?: number,
): Promise<LyricsResult | null> {
  const normalized = normalizeLyricsResult(lyrics);
  if (!normalized || normalized.synced || !normalized.plain) return normalized;
  if (!allowCommentAutoSync) return normalized;

  const pseudoSynced = buildPseudoSyncedLyricsFromResult(normalized, comments, trackDurationMs);
  if (pseudoSynced?.synced?.length) {
    return pseudoSynced;
  }

  return normalized;
}

export function buildLyricMotionHints(lines: LyricLine[] | null | undefined): LyricMotionHint[] {
  if (!lines || lines.length < 2) return [];

  const hints = lines
    .map((line, index) => {
      const normalized = normalizeLyricText(line.text);
      if (!normalized) return null;

      return {
        index,
        time: line.time,
        importance: getLyricLineImportance(normalized),
        density: getLyricLineDensity(normalized),
        onsetBias: getLyricOnsetBias(normalized),
        language: detectLyricLanguage(normalized),
      } satisfies LyricMotionHint;
    })
    .filter((hint): hint is LyricMotionHint => Boolean(hint));

  if (hints.length <= 6) return hints;

  const ranked = [...hints].sort((a, b) => {
    const scoreA = a.importance * 0.52 + a.density * 0.28 + a.onsetBias * 0.2;
    const scoreB = b.importance * 0.52 + b.density * 0.28 + b.onsetBias * 0.2;
    return scoreB - scoreA;
  });
  const keepCount = Math.max(6, Math.min(24, Math.round(hints.length * 0.3)));
  const keep = new Set(ranked.slice(0, keepCount).map((hint) => hint.index));

  return hints.filter((hint) => keep.has(hint.index));
}

export function getLyricMotionHintsForTrack(
  trackUrn: string,
  lyrics: LyricsResult | null,
): LyricMotionHint[] {
  if (!trackUrn || !lyrics?.synced?.length) return [];
  const cached = lyricMotionHintCache.get(trackUrn);
  if (cached) return cached;
  const next = buildLyricMotionHints(lyrics.synced);
  lyricMotionHintCache.set(trackUrn, next);
  return next;
}

async function searchMusixmatchSynced(
  artist: string,
  title: string,
  signal: AbortSignal,
): Promise<LyricsResult | null> {
  try {
    const token = await getMusixmatchToken(signal);
    if (!token) return null;

    const params = new URLSearchParams({
      q_artist: clean(artist),
      q_track: clean(title),
      subtitle_format: 'mxm',
      app_id: 'web-desktop-app-v1.0',
      usertoken: token,
    });

    const data = await requestJson<{
      message?: {
        body?: {
          subtitle?: {
            subtitle_body?: string;
          };
        };
      };
    }>(`${MUSIXMATCH_API}/matcher.subtitle.get?${params.toString()}`, signal);

    const subtitleBody = data?.message?.body?.subtitle?.subtitle_body;
    const synced = parseMusixmatchSubtitleBody(subtitleBody);
    if (!synced) return null;

    return { plain: null, synced, source: 'musixmatch' };
  } catch {
    return null;
  }
}

/** Parse LRC format: [mm:ss.xx] text */
function parseLRC(lrc: string): LyricLine[] {
  const normalized = normalizeLyricsTextBlock(lrc);
  if (!normalized) return [];

  const lines: LyricLine[] = [];
  let offsetSec = 0;

  for (const raw of normalized.split('\n')) {
    const matches = Array.from(raw.matchAll(LRC_TIMESTAMP_TAG_REGEX));
    if (matches.length === 0) continue;

    const text = normalizeLyricLineText(raw.replace(LRC_TIMESTAMP_TAG_REGEX, ''));

    for (const match of matches) {
      const tag = String(match[1] || '').trim();
      if (!tag) continue;

      const offsetMatch = tag.match(/^offset\s*:\s*(-?\d+(?:[.,]\d+)?)$/i);
      if (offsetMatch) {
        offsetSec = Number(offsetMatch[1].replace(',', '.')) / 1000;
        continue;
      }

      if (/^(?:ar|ti|al|by|re|ve|length|kana|lang(?:uage)?|artist|title|album)\s*:/i.test(tag)) {
        continue;
      }

      const time = parseLooseTimestamp(tag);
      if (time == null) continue;
      lines.push({ time: Math.max(0, time + offsetSec), text });
    }
  }

  return normalizeSyncedLyrics(lines) || [];
}

type LrclibEntry = {
  plainLyrics?: string;
  syncedLyrics?: string;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
};

function toResultLrclib(entry: LrclibEntry): LyricsResult | null {
  const plain = entry.plainLyrics || null;
  const parsedSynced = entry.syncedLyrics ? parseLRC(entry.syncedLyrics) : null;
  const synced = parsedSynced && parsedSynced.length > 0 ? parsedSynced : null;
  return normalizeLyricsResult({ plain, synced, source: 'lrclib' });
}

const AUDIO_FILE_EXTENSION_REGEX = /\.(?:mp3|wav|flac|ogg|aac|m4a|opus)\b/gi;

/** Remove feat/remix/brackets/special chars while keeping title identity tokens like .mp3 */
function clean(s: string, options: { stripAudioExtensions?: boolean } = {}): string {
  const { stripAudioExtensions = false } = options;
  let next = s
    .replace(/\(feat\.?[^)]*\)/gi, '')
    .replace(/\(ft\.?[^)]*\)/gi, '')
    .replace(/\[.*?\]/g, '')
    .replace(
      /\(.*?(remix|edit|version|mix|cover|live|acoustic|instrumental|original|prod).*?\)/gi,
      '',
    )
    .replace(/\s+(feat\.?|ft\.?|featuring|prod\.?)\b.*$/gi, '');

  if (stripAudioExtensions) {
    next = next.replace(AUDIO_FILE_EXTENSION_REGEX, ' ');
  }

  return next.replace(/\s+/g, ' ').trim();
}

function cleanLoose(s: string): string {
  return clean(s, { stripAudioExtensions: true });
}

/** Aggressively strip all parentheses and brackets */
function stripBrackets(s: string): string {
  return s
    .replace(/\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripDecorative(s: string): string {
  return String(s || '')
    .replace(/[\u2000-\u206F\u2E00-\u2E7F★✦•·∙｜»«◆◇○●]/gu, ' ')
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUnderscores(s: string): string {
  return String(s || '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripNoise(title: string): string {
  const raw = String(title || '').trim();
  if (!raw) return '';

  let cleaned = raw;
  for (const pattern of PRODUCER_TAG_PATTERNS) cleaned = cleaned.replace(pattern, ' ');
  for (const pattern of DERIVATIVE_VERSION_PATTERNS) cleaned = cleaned.replace(pattern, ' ');
  for (const pattern of REUPLOAD_NOISE_PATTERNS) cleaned = cleaned.replace(pattern, ' ');
  for (const pattern of EXTRA_TITLE_NOISE_PATTERNS) cleaned = cleaned.replace(pattern, ' ');

  return cleaned
    .replace(/\(\s*\)/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractReuploadCleanTitle(title: string): string | null {
  const raw = String(title || '').trim();
  if (!raw) return null;

  const cleaned = stripNoise(raw);

  return cleaned && cleaned !== raw ? cleaned : null;
}

function collectTitleVariants(title: string): string[] {
  const original = String(title || '').trim();
  if (!original) return [];

  const variants: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | null | undefined) => {
    const trimmed = String(value || '').trim();
    if (!trimmed || trimmed === original) return;
    const key = normalizeSearchText(trimmed);
    if (!key || seen.has(key)) return;
    seen.add(key);
    variants.push(trimmed);
  };

  const noDecor = stripDecorative(original);
  const noNoise = stripNoise(original);
  const noUnderscore = normalizeUnderscores(original);

  push(noNoise);
  push(noDecor);
  push(noUnderscore);
  push(stripNoise(noDecor));
  push(normalizeUnderscores(noDecor));
  push(stripDecorative(noNoise));
  push(normalizeUnderscores(noNoise));
  push(normalizeUnderscores(stripNoise(stripDecorative(original))));

  return variants;
}

function splitMultiArtistTitle(title: string): string[] {
  const raw = String(title || '').trim();
  if (!raw) return [];

  const cleaned = extractReuploadCleanTitle(raw) ?? raw;
  const parts = cleaned
    .split(/\s*(?:\+|&|×|x)\s*/iu)
    .map((part) => {
      let next = part.trim();
      for (const pattern of PRODUCER_TAG_PATTERNS) {
        next = next.replace(pattern, ' ').trim();
      }
      return next.replace(/\s+/g, ' ').trim();
    })
    .filter(Boolean);

  return Array.from(new Set(parts));
}

function extractArtistFromDescriptionFirstLine(description: string): string | null {
  const firstLine =
    String(description || '')
      .split('\n')[0]
      ?.trim() || '';
  if (!firstLine) return null;
  const parsed = splitArtistTitle(firstLine);
  return parsed?.[0] ?? null;
}

/** Strip everything non-alphanumeric (keep unicode letters) */
function alphaOnly(s: string): string {
  return s
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const CYRILLIC_TO_LATIN_MAP: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
  і: 'i',
  ї: 'yi',
  є: 'ie',
  ґ: 'g',
};

type GeniusSearchHitResult = {
  _type?: string;
  api_path?: string;
  full_title?: string;
  id?: number | string;
  name?: string;
  primary_artist?: { name?: string };
  title?: string;
  url?: string;
};

type GeniusSearchHit = {
  result?: GeniusSearchHitResult;
  type?: string;
};

type GeniusSearchSection = {
  hits?: GeniusSearchHit[];
  type?: string;
};

type GeniusSearchCandidate = {
  artist: string;
  fullTitle: string;
  normalizedArtist: string;
  normalizedCombined: string;
  normalizedSlug: string;
  normalizedTitle: string;
  title: string;
  url: string;
};

type GeniusArtistCandidate = {
  id: string | null;
  name: string;
  normalizedName: string;
  url: string | null;
};

function normalizeSearchText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STYLIZED_SYMBOL_TO_LATIN_MAP: Record<string, string> = {
  '!': 'i',
  $: 's',
  '+': 't',
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  ':': 'a',
  '@': 'a',
  '|': 'i',
};

const STYLIZED_SYMBOL_TO_CYRILLIC_MAP: Record<string, string> = {
  $: 'с',
  '0': 'о',
  '1': 'и',
  '3': 'е',
  '4': 'а',
  '5': 'с',
  '7': 'т',
  ':': 'а',
  '@': 'а',
};

const LATIN_TO_CYRILLIC_STYLIZED_MAP: Record<string, string> = {
  a: 'а',
  b: 'в',
  c: 'с',
  d: 'д',
  e: 'е',
  h: 'н',
  i: 'и',
  k: 'к',
  l: 'л',
  m: 'м',
  o: 'о',
  p: 'р',
  t: 'т',
  x: 'х',
  y: 'у',
};

function compactSearchText(value: string): string {
  return normalizeSearchText(value).replace(/\s+/g, '').trim();
}

function looksStylizedSearchText(value: string): boolean {
  const raw = String(value || '');
  if (!raw) return false;
  return /[!$+013457:@|]/.test(raw) || (/[а-яёіїєґ]/i.test(raw) && /[a-z]/i.test(raw));
}

function collectStylizedTextVariants(value: string): string[] {
  const raw = String(value || '').trim();
  if (!looksStylizedSearchText(raw)) return [];

  let latinSeed = '';
  let cyrillicSeed = '';

  for (const char of Array.from(raw)) {
    const lower = char.toLowerCase();
    const cyrillicMapped = CYRILLIC_TO_LATIN_MAP[lower];

    latinSeed += cyrillicMapped ?? STYLIZED_SYMBOL_TO_LATIN_MAP[lower] ?? char;
    cyrillicSeed +=
      LATIN_TO_CYRILLIC_STYLIZED_MAP[lower] ?? STYLIZED_SYMBOL_TO_CYRILLIC_MAP[lower] ?? char;
  }

  const variants: string[] = [];
  const seen = new Set<string>();
  const push = (next: string) => {
    const normalized = normalizeSearchText(next);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    variants.push(next.trim());
  };

  for (const source of [latinSeed, cyrillicSeed]) {
    push(source);
    push(compactSearchText(source));

    const transliterated = transliterateCyrillicToLatin(source);
    push(transliterated);
    push(compactSearchText(transliterated));
    push(softenLatinVariant(transliterated));
    push(compactSearchText(softenLatinVariant(transliterated)));
  }

  return variants;
}

function transliterateCyrillicToLatin(value: string): string {
  return Array.from(String(value || ''))
    .map((char) => {
      const lower = char.toLowerCase();
      const mapped = CYRILLIC_TO_LATIN_MAP[lower];
      if (mapped == null) return char;
      return char === lower ? mapped : mapped.charAt(0).toUpperCase() + mapped.slice(1);
    })
    .join('');
}

function softenLatinVariant(value: string): string {
  return normalizeSearchText(value)
    .replace(/shch/g, 'sch')
    .replace(/kh/g, 'h')
    .replace(/ts/g, 'c')
    .replace(/y/g, 'i');
}

function isNoiseTitleHint(value: string): boolean {
  const normalized = normalizeSearchText(value);
  if (!normalized) return true;
  if (normalized.length > 32) return true;

  for (const prefix of TITLE_HINT_NOISE_PREFIXES) {
    if (
      normalized === prefix ||
      normalized.startsWith(`${prefix} `) ||
      normalized.endsWith(` ${prefix}`)
    ) {
      return true;
    }
  }

  return false;
}

function collectParentheticalTitleHints(value: string | null | undefined): string[] {
  const hints: string[] = [];
  const seen = new Set<string>();
  const push = (next: string) => {
    const trimmed = String(next || '').trim();
    const normalized = normalizeSearchText(trimmed);
    if (!normalized || seen.has(normalized) || isNoiseTitleHint(trimmed)) return;
    seen.add(normalized);
    hints.push(trimmed);
  };

  const raw = String(value || '').trim();
  if (!raw.includes('(')) return hints;

  for (const match of raw.matchAll(/\(([^)]+)\)/g)) {
    push(String(match[1] || ''));
  }

  return hints;
}

function collectUploadStyleTitleHints(value: string | null | undefined): string[] {
  const hints: string[] = [];
  const seen = new Set<string>();
  const push = (next: string) => {
    const trimmed = String(next || '').trim();
    const normalized = normalizeSearchText(trimmed);
    if (!normalized || seen.has(normalized) || isNoiseTitleHint(trimmed)) return;
    seen.add(normalized);
    hints.push(trimmed);
  };

  const raw = String(value || '').trim();
  if (!raw || !raw.includes('(')) return hints;

  const match = raw.match(/^(.*?)\s*\(\s*([^)]+?)\s*\)\s*(?:[-–—/]{1,2}\s*(.+))?$/u);
  if (!match) return hints;

  const prefix = String(match[1] || '').trim();
  const inner = String(match[2] || '').trim();
  const suffix = String(match[3] || '').trim();
  if (!inner || isNoiseTitleHint(inner)) return hints;

  push(inner);
  if (prefix) {
    push(`${prefix} ${inner}`);
    push(`${prefix} (${inner})`);
    if (suffix) push(prefix);
  }

  return hints;
}

function collectLooseTitleOnlyCandidates(values: Array<string | null | undefined>): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (next: string) => {
    const trimmed = String(next || '').trim();
    const normalized = normalizeSearchText(trimmed);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(trimmed);
  };

  for (const value of values) {
    const raw = String(value || '').trim();
    for (const candidate of [
      stripDecorative(raw),
      extractReuploadCleanTitle(raw),
      stripBrackets(raw),
      clean(raw),
      stripDecorative(clean(raw)),
      stripBrackets(clean(raw)),
      cleanLoose(raw),
      stripDecorative(cleanLoose(raw)),
      stripBrackets(cleanLoose(raw)),
      ...collectStylizedTextVariants(raw),
      ...collectUploadStyleTitleHints(value),
      ...collectParentheticalTitleHints(value),
    ]) {
      if (candidate) push(candidate);
    }
  }

  return candidates;
}

function hasStrongTitleOnlyHint(title: string): boolean {
  const raw = String(title || '').trim();
  if (!raw) return false;
  if (/[^\u0000-\u007f]/.test(raw)) return true;

  const parentheticalHints = collectParentheticalTitleHints(raw);
  if (parentheticalHints.length > 0) return true;

  return false;
}

function getTextSearchVariants(value: string): string[] {
  const variants: string[] = [];
  const seen = new Set<string>();
  const push = (next: string) => {
    const normalized = normalizeSearchText(next);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    variants.push(normalized);
  };

  const raw = String(value || '').trim();
  const cleaned = clean(raw);
  const stripped = stripBrackets(raw);
  const alpha = alphaOnly(cleaned);
  const uploadStyleHints = collectUploadStyleTitleHints(raw);
  const parentheticalHints = collectParentheticalTitleHints(raw);
  const stylizedHints = collectStylizedTextVariants(raw);

  push(raw);
  for (const hint of uploadStyleHints) push(hint);
  for (const hint of parentheticalHints) push(hint);
  for (const hint of stylizedHints) push(hint);
  push(cleaned);
  push(stripped);
  push(alpha);

  for (const source of [
    raw,
    ...uploadStyleHints,
    ...parentheticalHints,
    ...stylizedHints,
    cleaned,
    stripped,
    alpha,
  ]) {
    const transliterated = transliterateCyrillicToLatin(source);
    push(transliterated);
    push(softenLatinVariant(transliterated));
    push(compactSearchText(source));
    push(compactSearchText(transliterated));
    push(compactSearchText(softenLatinVariant(transliterated)));
  }

  return variants;
}

function buildGeniusQueries(artist: string, title: string): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  const artistVariants = getTextSearchVariants(artist);
  const titleVariants = getTextSearchVariants(title);

  const push = (value: string) => {
    const normalized = normalizeSearchText(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    queries.push(normalized);
  };

  const primaryArtist = artistVariants[0] || '';
  const primaryTitle = titleVariants[0] || '';

  if (primaryArtist || primaryTitle) {
    push(`${primaryArtist} ${primaryTitle}`.trim());
  }

  for (const titleVariant of titleVariants.slice(0, 4)) {
    push(titleVariant);
  }

  for (const artistVariant of artistVariants.slice(1, 4)) {
    push(`${artistVariant} ${primaryTitle}`.trim());
  }

  for (const titleVariant of titleVariants.slice(1, 4)) {
    push(`${primaryArtist} ${titleVariant}`.trim());
  }

  const latinArtist = artistVariants.find(
    (value) => /[a-z]/.test(value) && !/[а-яёіїєґ]/i.test(value),
  );
  const latinTitle = titleVariants.find(
    (value) => /[a-z]/.test(value) && !/[а-яёіїєґ]/i.test(value),
  );
  if (latinArtist || latinTitle) {
    push(`${latinArtist || primaryArtist} ${latinTitle || primaryTitle}`.trim());
  }

  push(`${primaryTitle} ${primaryArtist}`.trim());

  for (const artistVariant of artistVariants.slice(0, 2)) {
    push(artistVariant);
  }

  return queries.slice(0, 10);
}

function extractGeniusSlug(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    return pathname
      .replace(/^\/+|\/+$/g, '')
      .replace(/-lyrics$/i, '')
      .replace(/-/g, ' ');
  } catch {
    return url;
  }
}

function toGeniusCandidate(hit: GeniusSearchHit): GeniusSearchCandidate | null {
  const url = hit.result?.url?.trim();
  if (!url) return null;

  const title = String(hit.result?.title || '').trim();
  const artist = String(hit.result?.primary_artist?.name || '').trim();
  const fullTitle = String(hit.result?.full_title || '').trim();
  const slug = extractGeniusSlug(url);

  return {
    artist,
    fullTitle,
    normalizedArtist: normalizeSearchText(artist),
    normalizedCombined: normalizeSearchText(`${artist} ${title} ${fullTitle} ${slug}`),
    normalizedSlug: normalizeSearchText(slug),
    normalizedTitle: normalizeSearchText(title),
    title,
    url,
  };
}

function toGeniusArtistCandidate(hit: GeniusSearchHit): GeniusArtistCandidate | null {
  const rawApiPath = String(hit.result?.api_path || '').trim();
  const idFromApiPath = rawApiPath.match(/\/artists\/([^/]+)/i)?.[1] || null;
  const rawId = hit.result?.id == null ? idFromApiPath : String(hit.result.id);
  const id = String(rawId || '').trim() || null;
  const name = String(hit.result?.name || '').trim();
  const url = String(hit.result?.url || '').trim() || null;

  if (!id && !name && !url) return null;

  return {
    id,
    name,
    normalizedName: normalizeSearchText(name),
    url,
  };
}

function getLiteralMatchBoost(
  haystack: string,
  needles: string[],
  exact: number,
  prefix: number,
  contains: number,
): number {
  let boost = 0;

  for (const needle of needles) {
    if (!needle) continue;
    if (haystack === needle) boost = Math.max(boost, exact);
    else if (haystack.startsWith(needle)) boost = Math.max(boost, prefix);
    else if (haystack.includes(needle)) boost = Math.max(boost, contains);
  }

  return boost;
}

function rankGeniusCandidates(
  candidates: GeniusSearchCandidate[],
  artist: string,
  title: string,
): GeniusSearchCandidate[] {
  if (candidates.length <= 1) return candidates;

  const artistVariants = getTextSearchVariants(artist);
  const titleVariants = getTextSearchVariants(title);
  const queryVariants = buildGeniusQueries(artist, title);

  const fuse = new Fuse(candidates, {
    ignoreLocation: true,
    includeScore: true,
    minMatchCharLength: 2,
    shouldSort: true,
    threshold: 0.42,
    keys: [
      { name: 'normalizedTitle', weight: 0.46 },
      { name: 'normalizedArtist', weight: 0.28 },
      { name: 'normalizedCombined', weight: 0.18 },
      { name: 'normalizedSlug', weight: 0.08 },
    ],
  });

  const scoreByUrl = new Map<string, number>();

  for (const candidate of candidates) {
    scoreByUrl.set(candidate.url, 10);
  }

  for (const query of queryVariants) {
    const results = fuse.search(query, { limit: Math.min(candidates.length, 8) });

    for (const result of results) {
      const candidate = result.item;
      const adjustedScore = Math.max(
        0,
        (result.score ?? 1) -
          getLiteralMatchBoost(candidate.normalizedTitle, titleVariants, 0.34, 0.2, 0.1) -
          getLiteralMatchBoost(candidate.normalizedArtist, artistVariants, 0.22, 0.12, 0.06) -
          getLiteralMatchBoost(candidate.normalizedCombined, queryVariants, 0.1, 0.05, 0.02) -
          getLiteralMatchBoost(candidate.normalizedSlug, queryVariants, 0.12, 0.06, 0.03),
      );

      const previous = scoreByUrl.get(candidate.url);
      if (previous == null || adjustedScore < previous) {
        scoreByUrl.set(candidate.url, adjustedScore);
      }
    }
  }

  return [...candidates].sort((a, b) => {
    const scoreA = scoreByUrl.get(a.url) ?? 10;
    const scoreB = scoreByUrl.get(b.url) ?? 10;
    if (scoreA !== scoreB) return scoreA - scoreB;
    return a.fullTitle.localeCompare(b.fullTitle);
  });
}

function toGeniusSlugPart(value: string): string {
  return normalizeSearchText(transliterateCyrillicToLatin(value))
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+/g, '-');
}

function buildGeniusArtistUrls(artist: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  for (const artistSlug of getTextSearchVariants(artist)
    .map(toGeniusSlugPart)
    .filter(Boolean)
    .slice(0, 4)) {
    const url = `https://genius.com/artists/${artistSlug}`;
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }

  return urls;
}

function buildGeniusDirectUrls(artist: string, title: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const artistSlugs = getTextSearchVariants(artist)
    .map(toGeniusSlugPart)
    .filter(Boolean)
    .slice(0, 4);
  const titleSlugs: string[] = [];
  const seenTitleSlugs = new Set<string>();
  const pushTitleSlug = (value: string) => {
    if (!value || seenTitleSlugs.has(value)) return;
    seenTitleSlugs.add(value);
    titleSlugs.push(value);
  };

  for (const titleSlug of getTextSearchVariants(title).map(toGeniusSlugPart).filter(Boolean)) {
    pushTitleSlug(titleSlug);
    pushTitleSlug(titleSlug.replace(/-(aac|flac|m4a|mp3|ogg|opus|wav)(?=$|-)/gi, '$1'));
  }

  const push = (artistSlug: string, titleSlug: string) => {
    if (!artistSlug || !titleSlug) return;
    const url = `https://genius.com/${artistSlug}-${titleSlug}-lyrics`;
    if (seen.has(url)) return;
    seen.add(url);
    urls.push(url);
  };

  for (const artistSlug of artistSlugs) {
    for (const titleSlug of titleSlugs.slice(0, 8)) {
      push(artistSlug, titleSlug);
      if (urls.length >= 10) return urls;
    }
  }

  return urls;
}

function extractGeniusSongCandidatesFromArtistHtml(
  html: string,
  artistHint: string,
): GeniusSearchCandidate[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const candidatesByUrl = new Map<string, GeniusSearchCandidate>();

  for (const anchor of Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href*="-lyrics"]'))) {
    const href = String(anchor.getAttribute('href') || '').trim();
    if (!href) continue;

    let url: string;
    try {
      url = new URL(href, 'https://genius.com').toString();
    } catch {
      continue;
    }

    if (!/-lyrics(?:$|[?#])/i.test(url) || candidatesByUrl.has(url)) continue;

    const rawTitle = String(anchor.getAttribute('title') || anchor.textContent || '').trim();
    const title = clean(rawTitle) || extractGeniusSlug(url);
    const candidate = toGeniusCandidate({
      result: {
        full_title: artistHint ? `${artistHint} ${title}` : title,
        primary_artist: { name: artistHint },
        title,
        url,
      },
    });

    if (candidate) {
      candidatesByUrl.set(candidate.url, candidate);
    }
  }

  return [...candidatesByUrl.values()];
}

function extractGeniusCandidateFromHtml(
  html: string,
  fallbackUrl: string,
): GeniusSearchCandidate | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const metaTitle =
    doc.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() ||
    doc.querySelector('meta[name="twitter:title"]')?.getAttribute('content')?.trim() ||
    doc.title?.trim() ||
    '';

  const normalizedTitle = metaTitle.replace(/\s+\|\s+Genius Lyrics$/i, '').trim();
  const match = normalizedTitle.match(/^(.*?)\s+[–—-]\s+(.*?)\s+Lyrics$/i);
  const artist = String(match?.[1] || '').trim();
  const title = String(match?.[2] || '').trim();

  if (!artist && !title) return null;

  return toGeniusCandidate({
    result: {
      full_title: `${artist} ${title}`.trim(),
      primary_artist: { name: artist },
      title,
      url: fallbackUrl,
    },
  });
}

async function fetchGeniusArtistSongCandidates(
  artistCandidate: GeniusArtistCandidate,
  signal: AbortSignal,
): Promise<GeniusSearchCandidate[]> {
  const candidatesByUrl = new Map<string, GeniusSearchCandidate>();
  const pushCandidate = (candidate: GeniusSearchCandidate | null) => {
    if (!candidate || candidatesByUrl.has(candidate.url)) return;
    candidatesByUrl.set(candidate.url, candidate);
  };

  if (artistCandidate.url) {
    try {
      const html = await requestText(artistCandidate.url, signal);
      for (const candidate of extractGeniusSongCandidatesFromArtistHtml(
        html,
        artistCandidate.name,
      )) {
        pushCandidate(candidate);
      }
    } catch {
      // fall through to API-based artist song discovery
    }
  }

  if (artistCandidate.id) {
    const plans: Array<{ maxPages: number; sort: 'popularity' | 'title' }> = [
      { maxPages: 3, sort: 'popularity' },
      { maxPages: 2, sort: 'title' },
    ];

    for (const plan of plans) {
      for (let page = 1; page <= plan.maxPages; page += 1) {
        try {
          const songsData = await requestJson<{
            response?: {
              next_page?: number | null;
              songs?: GeniusSearchHitResult[];
            };
          }>(
            `https://genius.com/api/artists/${encodeURIComponent(artistCandidate.id)}/songs?page=${page}&per_page=20&sort=${plan.sort}`,
            signal,
          );

          const songs = songsData?.response?.songs || [];
          if (songs.length === 0) break;

          for (const song of songs) {
            pushCandidate(toGeniusCandidate({ result: song }));
          }

          const nextPage = songsData?.response?.next_page;
          if (!nextPage || nextPage === page) break;
        } catch {
          break;
        }
      }

      if (candidatesByUrl.size >= 60) break;
    }
  }

  return [...candidatesByUrl.values()];
}

function normalizeGeniusPlainLyrics(plainLyrics: string): string {
  return cleanGeniusLyricsText(plainLyrics);
}

/** Parse "Artist - Title" from a combined string */
export function splitArtistTitle(raw: string): [string, string] | null {
  for (const sep of [' - ', ' – ', ' — ', ' // ']) {
    const idx = raw.indexOf(sep);
    if (idx > 0) {
      const artist = raw.slice(0, idx).trim();
      const title = raw.slice(idx + sep.length).trim();
      if (artist && title) return [artist, title];
    }
  }
  return null;
}

// ── LRCLib ────────────────────────────────────────────────────

type LyricsSearchProfile = {
  requestedArtist: string;
  requestedTitle: string;
  originalTitle: string;
  uploaderUsername: string;
  durationSec: number | null;
  requiredTitleTokens: string[];
  artistVariants: string[];
  titleVariants: string[];
  combinedVariants: string[];
  metadataTokens: string[];
  allowLooseTitleOnly: boolean;
};

function tokenizeSearchText(value: string): string[] {
  return normalizeSearchText(value).split(' ').filter(Boolean);
}

function collectSearchVariants(values: Array<string | null | undefined>): string[] {
  const variants: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    for (const variant of getTextSearchVariants(String(value || ''))) {
      if (!variant || seen.has(variant)) continue;
      seen.add(variant);
      variants.push(variant);
    }
  }

  return variants;
}

function parseTagListPhrases(tagList: string | null | undefined): string[] {
  if (!tagList) return [];

  const quoted = Array.from(tagList.matchAll(/\"([^\"]+)\"|'([^']+)'/g))
    .map((match) => String(match[1] || match[2] || '').trim())
    .filter(Boolean);

  const remainder = tagList.replace(/\"([^\"]+)\"|'([^']+)'/g, ' ');
  const chunks = remainder
    .split(/[,#/|]+/g)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  return [...quoted, ...chunks].slice(0, 8);
}

function collectArtistAliasHints(values: Array<string | null | undefined>): string[] {
  const hints: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    const normalized = normalizeSearchText(value);
    if (!normalized || seen.has(normalized)) return;
    if (!/^[a-z0-9_ ]{3,32}$/i.test(normalized)) return;
    if (!/[a-z]/i.test(normalized)) return;
    if (
      /^(?:http|https|www|soundcloud|telegram|tme|link|links|official|music|artist)$/i.test(
        normalized,
      )
    ) {
      return;
    }
    seen.add(normalized);
    hints.push(value.trim());
  };

  for (const value of values) {
    const raw = String(value || '');
    if (!raw) continue;

    for (const match of raw.matchAll(/(?:https?:\/\/)?t\.me\/([a-z0-9_]{3,32})/gi)) {
      push(String(match[1] || ''));
    }

    for (const match of raw.matchAll(/\btgk\s*[-:]\s*([a-z0-9_]{3,32})\b/gi)) {
      push(String(match[1] || ''));
    }

    for (const match of raw.matchAll(/(?:^|[\s(])@([a-z0-9_]{3,32})(?=$|[\s),.!?])/gi)) {
      push(String(match[1] || ''));
    }

    for (const match of raw.matchAll(/(?:^|[\s(])([a-z][a-z0-9_]{2,31})(?=$|[\s),.!?])/gi)) {
      push(String(match[1] || ''));
    }
  }

  return hints.slice(0, 4);
}

function buildLyricsMetadataTokens(options: LyricsSearchOptions): string[] {
  const descriptionLines = String(options.description || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^https?:\/\//i.test(line))
    .slice(0, 4);

  const sources = [
    options.genre || '',
    ...parseTagListPhrases(options.tagList),
    ...descriptionLines,
  ];

  const tokens = sources.flatMap((value) => tokenizeSearchText(value));
  return [...new Set(tokens)].slice(0, 28);
}

function collectRequiredTitleTokens(values: Array<string | null | undefined>): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    for (const token of tokenizeSearchText(String(value || ''))) {
      if (!REQUIRED_TITLE_IDENTITY_TOKENS.has(token) && !/\d/.test(token)) continue;
      if (seen.has(token)) continue;
      seen.add(token);
      tokens.push(token);
    }
  }

  return tokens;
}

function hasMissingRequiredTitleTokens(title: string, requiredTitleTokens: string[]): boolean {
  if (requiredTitleTokens.length === 0) return false;
  const candidateTokens = new Set(tokenizeSearchText(title));
  return requiredTitleTokens.some((token) => !candidateTokens.has(token));
}

function canUseLooseTitleOnly(title: string): boolean {
  const normalized = normalizeSearchText(title);
  if (!normalized) return false;
  const tokens = tokenizeSearchText(normalized);
  return tokens.length >= 2 || normalized.length >= 8 || hasStrongTitleOnlyHint(title);
}

function isAmbiguousShortTitle(title: string): boolean {
  const normalized = normalizeSearchText(title);
  if (!normalized) return false;
  const tokens = tokenizeSearchText(normalized);
  return tokens.length <= 1 && normalized.length <= 7;
}

function buildLyricsSearchProfile(
  requestedArtist: string,
  requestedTitle: string,
  options: LyricsSearchOptions,
): LyricsSearchProfile {
  const originalTitle = String(options.originalTitle || requestedTitle || '').trim();
  const uploaderUsername = String(options.uploaderUsername || requestedArtist || '').trim();
  const descriptionArtistHint = options.description
    ? extractArtistFromDescriptionFirstLine(options.description)
    : null;
  const titleArtistHints = Array.from(
    new Set([...splitMultiArtistTitle(requestedTitle), ...splitMultiArtistTitle(originalTitle)]),
  );
  const artistAliasHints = collectArtistAliasHints([
    options.description,
    options.uploaderUsername,
    requestedArtist,
    descriptionArtistHint,
    ...titleArtistHints,
  ]);
  const durationSec =
    options.durationMs != null && Number.isFinite(options.durationMs)
      ? Math.max(Number(options.durationMs) / 1000, 0)
      : null;

  return {
    requestedArtist: String(requestedArtist || '').trim(),
    requestedTitle: String(requestedTitle || '').trim(),
    originalTitle,
    uploaderUsername,
    durationSec,
    requiredTitleTokens: collectRequiredTitleTokens([requestedTitle, originalTitle]),
    artistVariants: collectSearchVariants([
      requestedArtist,
      uploaderUsername,
      descriptionArtistHint,
      ...titleArtistHints,
      ...artistAliasHints,
    ]),
    titleVariants: collectSearchVariants([requestedTitle, originalTitle]),
    combinedVariants: collectSearchVariants([
      `${requestedArtist} ${requestedTitle}`,
      `${uploaderUsername} ${originalTitle}`,
      `${requestedArtist} ${originalTitle}`,
      `${uploaderUsername} ${requestedTitle}`,
      ...titleArtistHints.map((artistHint) => `${artistHint} ${requestedTitle}`),
      ...titleArtistHints.map((artistHint) => `${artistHint} ${originalTitle}`),
      ...artistAliasHints.map((artistAlias) => `${artistAlias} ${requestedTitle}`),
      ...artistAliasHints.map((artistAlias) => `${artistAlias} ${originalTitle}`),
      requestedTitle,
      originalTitle,
    ]),
    metadataTokens: buildLyricsMetadataTokens(options),
    allowLooseTitleOnly:
      canUseLooseTitleOnly(requestedTitle) || canUseLooseTitleOnly(originalTitle),
  };
}

function getVariantMatchScore(candidate: string, variants: string[]): number {
  const normalizedCandidate = normalizeSearchText(candidate);
  if (!normalizedCandidate || variants.length === 0) return 0;

  const candidateTokens = tokenizeSearchText(normalizedCandidate);
  let best = getLiteralMatchBoost(normalizedCandidate, variants, 1, 0.84, 0.64);

  for (const variant of variants) {
    if (!variant) continue;
    const variantTokens = tokenizeSearchText(variant);
    if (variantTokens.length === 0) continue;

    const overlap = tokenOverlapScore(candidateTokens, variantTokens);
    const ordered = orderedTokenScore(variantTokens, candidateTokens);
    const substring =
      normalizedCandidate.includes(variant) || variant.includes(normalizedCandidate) ? 0.72 : 0;

    best = Math.max(best, overlap * 0.76 + ordered * 0.14, substring);
  }

  return Math.min(best, 1);
}

function getDurationMatchBoost(expectedSec: number | null, candidateSec: number | null): number {
  if (
    expectedSec == null ||
    candidateSec == null ||
    !Number.isFinite(expectedSec) ||
    !Number.isFinite(candidateSec)
  ) {
    return 0;
  }

  const delta = Math.abs(expectedSec - candidateSec);
  const ratio = delta / Math.max(expectedSec, candidateSec, 1);

  if (delta <= 4) return 0.22;
  if (delta <= 9) return 0.14;
  if (delta <= 18) return 0.06;
  if (ratio >= 0.35) return -0.2;
  if (ratio >= 0.22) return -0.1;
  return 0;
}

function scoreLyricsCandidate(
  profile: LyricsSearchProfile,
  artist: string,
  title: string,
  extraText = '',
  durationSec: number | null = null,
): { score: number; titleScore: number; artistScore: number; combinedScore: number } {
  const titleScore = getVariantMatchScore(title, profile.titleVariants);
  const artistScore = getVariantMatchScore(artist, profile.artistVariants);
  const combinedText = `${artist} ${title} ${extraText}`.trim();
  const combinedScore = getVariantMatchScore(combinedText, profile.combinedVariants);
  const metadataScore =
    profile.metadataTokens.length > 0
      ? tokenOverlapScore(profile.metadataTokens, tokenizeSearchText(combinedText))
      : 0;
  const durationBoost = getDurationMatchBoost(profile.durationSec, durationSec);

  return {
    score:
      titleScore * 0.58 +
      artistScore * 0.28 +
      combinedScore * 0.14 +
      metadataScore * 0.08 +
      durationBoost,
    titleScore,
    artistScore,
    combinedScore,
  };
}

function isAcceptedLyricsCandidateScore(
  profile: LyricsSearchProfile,
  scored: { score: number; titleScore: number; artistScore: number; combinedScore: number },
  candidateArtist = '',
  candidateTitle = '',
): boolean {
  const requiresStrongArtistMatch =
    !profile.allowLooseTitleOnly &&
    (isAmbiguousShortTitle(profile.requestedTitle) || isAmbiguousShortTitle(profile.originalTitle));
  const minScore = requiresStrongArtistMatch ? 0.78 : 0.56;
  const minTitleScore = requiresStrongArtistMatch ? 0.72 : 0.52;
  const minArtistScore = requiresStrongArtistMatch ? 0.22 : 0;

  if (
    scored.score < minScore ||
    scored.titleScore < minTitleScore ||
    scored.artistScore < minArtistScore
  ) {
    return false;
  }

  const normalizedCandidateArtist = normalizeSearchText(candidateArtist);
  if (profile.artistVariants.length > 0 && normalizedCandidateArtist) {
    const softMinArtistScore = requiresStrongArtistMatch ? 0.22 : 0.16;
    const softMinCombinedScore = requiresStrongArtistMatch ? 0.58 : 0.52;
    if (scored.artistScore < softMinArtistScore && scored.combinedScore < softMinCombinedScore) {
      return false;
    }
  }

  if (hasMissingRequiredTitleTokens(candidateTitle, profile.requiredTitleTokens)) {
    const strongMinArtistScore = requiresStrongArtistMatch ? 0.3 : 0.24;
    const strongMinCombinedScore = requiresStrongArtistMatch ? 0.66 : 0.6;
    if (
      scored.artistScore < strongMinArtistScore &&
      scored.combinedScore < strongMinCombinedScore
    ) {
      return false;
    }
  }

  return true;
}

function pickBestLyricsCandidate<T>(
  candidates: T[],
  profile: LyricsSearchProfile,
  select: (item: T) => {
    artist?: string | null;
    title?: string | null;
    extraText?: string | null;
    durationSec?: number | null;
  },
): T | null {
  const ranked = candidates
    .map((item) => {
      const meta = select(item);
      const title = String(meta.title || '').trim();
      const artist = String(meta.artist || '').trim();
      const extraText = String(meta.extraText || '').trim();
      const durationSec =
        meta.durationSec != null && Number.isFinite(meta.durationSec)
          ? Number(meta.durationSec)
          : null;
      const scored = scoreLyricsCandidate(profile, artist, title, extraText, durationSec);
      return { item, ...scored };
    })
    .sort(
      (a, b) => b.score - a.score || b.titleScore - a.titleScore || b.artistScore - a.artistScore,
    );

  const best = ranked[0];
  if (!best) return null;

  const bestMeta = select(best.item);
  const bestArtist = String(bestMeta.artist || '').trim();
  const bestTitle = String(bestMeta.title || '').trim();
  if (!isAcceptedLyricsCandidateScore(profile, best, bestArtist, bestTitle)) {
    logLyricsDebug('rejecting low-confidence lyrics candidate', {
      requestedArtist: profile.requestedArtist,
      requestedTitle: profile.requestedTitle,
      originalTitle: profile.originalTitle,
      bestScore: Number(best.score.toFixed(3)),
      titleScore: Number(best.titleScore.toFixed(3)),
      artistScore: Number(best.artistScore.toFixed(3)),
      combinedScore: Number(best.combinedScore.toFixed(3)),
      candidateArtist: bestArtist,
      candidateTitle: bestTitle,
      missingRequiredTitleTokens: hasMissingRequiredTitleTokens(
        bestTitle,
        profile.requiredTitleTokens,
      ),
    });
    return null;
  }

  return best.item;
}

async function lrclibFetch(
  params: Record<string, string>,
  profile: LyricsSearchProfile,
  signal: AbortSignal,
): Promise<LyricsResult | null> {
  try {
    const url = `${LRCLIB_API}/search?${new URLSearchParams(params)}`;
    const data = await requestJson<LrclibEntry[]>(url, signal);
    if (!data?.length) return null;
    const best = pickBestLyricsCandidate(data, profile, (entry) => ({
      artist: entry.artistName,
      title: entry.trackName,
      extraText: entry.albumName,
      durationSec: entry.duration,
    }));
    return best ? toResultLrclib(best) : null;
  } catch {
    return null;
  }
}

async function searchLrclib(
  artist: string,
  title: string,
  profile: LyricsSearchProfile,
  signal: AbortSignal,
  syncedOnly = false,
): Promise<LyricsResult | null> {
  const tryFetch = async (params: Record<string, string>) => {
    const r = await lrclibFetch(params, profile, signal);
    if (syncedOnly && r && !r.synced?.length) return null;
    return r ?? null;
  };

  // 1. Exact
  let r = await tryFetch({ artist_name: artist, track_name: title });
  if (r) return r;
  // 2. Cleaned
  const ca = clean(artist);
  const ct = clean(title);
  r = await tryFetch({ artist_name: ca, track_name: ct });
  if (r) return r;
  // 3. Alpha-only
  const aa = alphaOnly(ca);
  const at = alphaOnly(ct);
  if (aa !== ca || at !== ct) {
    r = await tryFetch({ artist_name: aa, track_name: at });
    if (r) return r;
  }
  // 4. Free-text q=
  r = await tryFetch({ q: alphaOnly(`${artist} ${title}`) });
  return r;
}

// ── NetEase Cloud Music ───────────────────────────────────────

async function searchNetease(
  artist: string,
  title: string,
  profile: LyricsSearchProfile,
  signal: AbortSignal,
): Promise<LyricsResult | null> {
  try {
    const q = encodeURIComponent(`${clean(artist)} ${clean(title)}`);
    const searchData = await requestJson<{
      result?: {
        songs?: Array<{
          id?: number;
          name?: string;
          duration?: number;
          dt?: number;
          artists?: Array<{ name?: string }>;
          ar?: Array<{ name?: string }>;
          album?: { name?: string };
          al?: { name?: string };
        }>;
      };
    }>(`${NCM_API}/search?keywords=${q}&type=1`, signal);
    const songs = searchData?.result?.songs || [];
    const bestSong = pickBestLyricsCandidate(songs, profile, (song) => ({
      artist: (song.artists || song.ar || [])
        .map((entry) => entry?.name || '')
        .filter(Boolean)
        .join(' '),
      title: song.name,
      extraText: song.album?.name || song.al?.name || '',
      durationSec:
        song.duration != null && Number.isFinite(song.duration)
          ? Number(song.duration) / 1000
          : song.dt != null && Number.isFinite(song.dt)
            ? Number(song.dt) / 1000
            : null,
    }));
    const id = bestSong?.id;
    if (!id) return null;

    const lrcData = await requestJson<any>(`${NCM_API}/lyric?id=${id}`, signal);

    const syncedLrc = lrcData?.lrc?.lyric;
    const tlyric = lrcData?.tlyric?.lyric; // Translated (optional fallback)
    const romalrc = lrcData?.romalrc?.lyric;
    const klyric = lrcData?.klyric?.lyric;

    return normalizeLyricsResult({
      plain: extractPlainLyricsFromUnknown({
        lyrics: tlyric || syncedLrc || romalrc || klyric || null,
      }),
      synced: extractSyncedLyricsFromUnknown({
        lrc: syncedLrc,
        tlyric,
        romalrc,
        klyric,
      }),
      source: 'netease',
    });
  } catch {
    return null;
  }
}

// ── lyrics.ovh (Musixmatch backend) ──────────────────────────

async function searchMusixmatch(
  artist: string,
  title: string,
  signal: AbortSignal,
): Promise<LyricsResult | null> {
  try {
    const url = `${LYRICS_OVH_API}/${encodeURIComponent(clean(artist))}/${encodeURIComponent(clean(title))}`;
    const data = await requestJson<unknown>(url, signal);
    return normalizeLyricsResult({
      plain: extractPlainLyricsFromUnknown(data),
      synced: extractSyncedLyricsFromUnknown(data),
      source: 'musixmatch',
    });
  } catch {
    return null;
  }
}

// ── Direct Genius Scraper ────────────────────────────────────────

async function searchGenius(
  artist: string,
  title: string,
  signal: AbortSignal,
): Promise<LyricsResult | null> {
  try {
    const profile = buildLyricsSearchProfile(artist, title, {
      originalTitle: title,
      uploaderUsername: artist,
    });
    const tryDirectUrls = async () => {
      for (const url of buildGeniusDirectUrls(artist, title)) {
        try {
          const html = await requestText(url, signal);
          const pageCandidate = extractGeniusCandidateFromHtml(html, url);
          if (
            pageCandidate &&
            !isAcceptedLyricsCandidateScore(
              profile,
              scoreLyricsCandidate(
                profile,
                pageCandidate.artist,
                pageCandidate.title,
                `${pageCandidate.fullTitle} ${extractGeniusSlug(pageCandidate.url)}`,
              ),
              pageCandidate.artist,
              pageCandidate.title,
            )
          ) {
            continue;
          }
          const result = normalizeLyricsResult({
            plain: normalizeGeniusPlainLyrics(extractGeniusLyricsFromHtml(html) || ''),
            synced: null,
            source: 'genius',
          });
          if (result) {
            return result;
          }
        } catch {
          // try next direct slug candidate
        }
      }

      return null;
    };

    if (profile.requiredTitleTokens.length > 0) {
      const direct = await tryDirectUrls();
      if (direct) return direct;
    }

    const queries = buildGeniusQueries(artist, title);
    const candidatesByUrl = new Map<string, GeniusSearchCandidate>();
    const artistCandidates: GeniusArtistCandidate[] = [];
    const seenArtistCandidateKeys = new Set<string>();
    const pushArtistCandidate = (candidate: GeniusArtistCandidate | null) => {
      if (!candidate) return;

      const keys = [
        candidate.id ? `id:${candidate.id}` : '',
        candidate.url ? `url:${candidate.url}` : '',
      ].filter(Boolean);
      if (keys.length === 0 && candidate.normalizedName) {
        keys.push(`name:${candidate.normalizedName}`);
      }
      if (keys.some((key) => seenArtistCandidateKeys.has(key))) return;

      for (const key of keys) {
        seenArtistCandidateKeys.add(key);
      }
      artistCandidates.push(candidate);
    };

    for (const query of queries) {
      try {
        const searchUrl = `https://genius.com/api/search/multi?per_page=5&q=${encodeURIComponent(query)}`;
        const searchData = await requestJson<{
          response?: {
            sections?: GeniusSearchSection[];
          };
        }>(searchUrl, signal);

        for (const section of searchData?.response?.sections || []) {
          for (const hit of section.hits || []) {
            const resultType = normalizeSearchText(
              String(hit.result?._type || section.type || hit.type || ''),
            );

            if (resultType === 'song') {
              const candidate = toGeniusCandidate(hit);
              if (!candidate || candidatesByUrl.has(candidate.url)) continue;
              candidatesByUrl.set(candidate.url, candidate);
              continue;
            }

            if (resultType === 'artist') {
              pushArtistCandidate(toGeniusArtistCandidate(hit));
            }
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw err;
        }
      }
      if (candidatesByUrl.size >= 12) break;
    }

    for (const url of buildGeniusArtistUrls(artist)) {
      pushArtistCandidate({
        id: null,
        name: artist,
        normalizedName: normalizeSearchText(artist),
        url,
      });
    }

    if (
      artistCandidates.length > 0 &&
      (hasStrongTitleOnlyHint(title) || candidatesByUrl.size < 10)
    ) {
      for (const artistCandidate of artistCandidates.slice(0, 3)) {
        for (const candidate of await fetchGeniusArtistSongCandidates(artistCandidate, signal)) {
          if (!candidatesByUrl.has(candidate.url)) {
            candidatesByUrl.set(candidate.url, candidate);
          }
        }

        if (candidatesByUrl.size >= 24) break;
      }
    }

    const rankedCandidates = rankGeniusCandidates([...candidatesByUrl.values()], artist, title);
    const acceptedCandidates = rankedCandidates.filter((candidate) =>
      isAcceptedLyricsCandidateScore(
        profile,
        scoreLyricsCandidate(
          profile,
          candidate.artist,
          candidate.title,
          `${candidate.fullTitle} ${extractGeniusSlug(candidate.url)}`,
        ),
        candidate.artist,
        candidate.title,
      ),
    );

    for (const candidate of acceptedCandidates.slice(0, 12)) {
      const html = await requestText(candidate.url, signal);
      const result = normalizeLyricsResult({
        plain: normalizeGeniusPlainLyrics(extractGeniusLyricsFromHtml(html) || ''),
        synced: null,
        source: 'genius',
      });
      if (result) {
        return result;
      }
    }

    return await tryDirectUrls();
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return null;
    }
    console.warn('Genius Scrape error:', err);
    return null;
  }
}

// ── Textyl ───────────────────────────────────────────────────

async function searchTextyl(
  artist: string,
  title: string,
  signal: AbortSignal,
): Promise<LyricsResult | null> {
  try {
    const q = encodeURIComponent(`${clean(artist)} ${clean(title)}`);
    const url = `${TEXTYL_API}?q=${q}`;
    const data = await requestJson<unknown>(url, signal);
    return normalizeLyricsResult({
      plain: extractPlainLyricsFromUnknown(data),
      synced: extractSyncedLyricsFromUnknown(data),
      source: 'textyl',
    });
  } catch {
    return null;
  }
}

async function searchPlainLyricsProviders(
  artist: string,
  title: string,
  signal: AbortSignal,
): Promise<LyricsResult | null> {
  return await firstNonNull<LyricsResult>([
    () => searchMusixmatch(artist, title, signal),
    () => searchGenius(artist, title, signal),
    () => searchTextyl(artist, title, signal),
  ]);
}

async function searchSyncedParallel(
  artist: string,
  title: string,
  profile: LyricsSearchProfile,
  signal: AbortSignal,
): Promise<LyricsResult | null> {
  const candidates: Array<() => Promise<LyricsResult | null>> = [
    () => searchLrclib(artist, title, profile, signal, true),
    () => searchMusixmatchSynced(artist, title, signal),
  ];
  if (ENABLE_NCM) {
    candidates.push(() => searchNetease(artist, title, profile, signal));
  }

  return await new Promise<LyricsResult | null>((resolve) => {
    let pending = candidates.length;
    let settled = false;

    for (const candidate of candidates) {
      candidate()
        .then((result) => {
          if (settled) return;
          if (result?.synced?.length) {
            settled = true;
            resolve(result);
            return;
          }
          pending -= 1;
          if (pending === 0) resolve(null);
        })
        .catch(() => {
          if (settled) return;
          pending -= 1;
          if (pending === 0) resolve(null);
        });
    }
  });
}

async function runChainFull(
  artist: string,
  title: string,
  profile: LyricsSearchProfile,
  signal: AbortSignal,
): Promise<LyricsResult | null> {
  const trimmedArtist = String(artist || '').trim();
  const trimmedTitle = String(title || '').trim();
  if (!trimmedTitle) return null;

  let r = await searchLrclib(trimmedArtist, trimmedTitle, profile, signal);
  if (r) return r;
  r = await searchMusixmatchSynced(trimmedArtist, trimmedTitle, signal);
  if (r) return r;
  r = await searchPlainLyricsProviders(trimmedArtist, trimmedTitle, signal);
  if (r) return r;
  if (ENABLE_NCM) {
    r = await searchNetease(trimmedArtist, trimmedTitle, profile, signal);
    if (r) return r;
  }
  return null;
}

// ── Main export ───────────────────────────────────────────────

function toFiniteNumber(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeKrokoTime(rawTime: number): number {
  return rawTime > 10000 ? rawTime / 1000 : rawTime;
}

function parseKrokoPayload(payload: unknown): LyricLine[] | null {
  return extractSyncedLyricsFromUnknown(payload);
}

async function fetchKrokoPayload(
  artist: string,
  title: string,
  plainLyrics: string | null,
  signal: AbortSignal,
): Promise<unknown | null> {
  if (!ENABLE_KROKO_ASR || !KROKO_ASR_URL) return null;

  const cleanedArtist = clean(artist);
  const cleanedTitle = clean(title);
  const apiKey = (import.meta.env.VITE_LYRICS_KROKO_ASR_KEY || '').trim();

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
    headers['x-api-key'] = apiKey;
  }

  const payload = {
    artist: cleanedArtist,
    title: cleanedTitle,
    query: `${cleanedArtist} ${cleanedTitle}`.trim(),
    plainLyrics,
    lyrics: plainLyrics,
    mode: 'lyrics_timing',
    format: 'lines',
  };

  const postRes = await fetch(KROKO_ASR_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal,
  });

  if (postRes.ok) {
    return await postRes.json();
  }

  if (![404, 405, 415].includes(postRes.status)) {
    return null;
  }

  const queryUrl = new URL(KROKO_ASR_URL);
  if (cleanedArtist) queryUrl.searchParams.set('artist', cleanedArtist);
  if (cleanedTitle) queryUrl.searchParams.set('title', cleanedTitle);
  if (plainLyrics) queryUrl.searchParams.set('lyrics', plainLyrics.slice(0, 2000));

  const getRes = await fetch(queryUrl.toString(), {
    method: 'GET',
    headers: apiKey
      ? {
          authorization: `Bearer ${apiKey}`,
          'x-api-key': apiKey,
        }
      : undefined,
    signal,
  });

  if (!getRes.ok) return null;
  return await getRes.json();
}

async function searchKrokoAsr(
  artist: string,
  title: string,
  plainLyrics: string | null,
  signal: AbortSignal,
): Promise<LyricsResult | null> {
  try {
    const payload = await fetchKrokoPayload(artist, title, plainLyrics, signal);
    const synced = parseKrokoPayload(payload);
    if (!synced || synced.length === 0) return null;
    const resolvedPlain = extractPlainLyricsFromUnknown(payload) ?? plainLyrics;

    return {
      plain: resolvedPlain,
      synced,
      source: 'kroko',
    };
  } catch {
    return null;
  }
}

function parseQwenPayload(
  payload: unknown,
  plainLyrics: string | null,
  trackDurationSec?: number,
): LyricLine[] | null {
  const directLines = parseKrokoPayload(payload);
  if (directLines && directLines.length > 0) return directLines;
  if (!plainLyrics) return null;

  const words = extractVoskWords(payload);
  if (!words || words.length === 0) {
    warnLyricsDebug(
      'Qwen payload has no usable words, falling back to duration-only sync',
      summarizePayloadForDebug(payload),
    );
    return buildDurationOnlySyncedLyrics(plainLyrics, trackDurationSec);
  }
  const coverage = getRecognizedCoverageScore(plainLyrics, words);
  if (words.length < 4 || coverage < 0.08) {
    warnLyricsDebug('Qwen recognition coverage is too low, falling back to duration-only sync', {
      words: words.length,
      coverage,
      plainLength: plainLyrics.length,
    });
    return buildDurationOnlySyncedLyrics(plainLyrics, trackDurationSec);
  }
  const aligned = buildSyncedLyricsFromWordTimings(plainLyrics, words, trackDurationSec);
  if (aligned && aligned.length > 0) return aligned;

  warnLyricsDebug('Qwen word alignment fell back to weighted line timing', {
    words: words.length,
    plainLength: plainLyrics.length,
  });
  return buildWeightedSyncedLyricsFallback(plainLyrics, words, trackDurationSec);
}

async function searchDesktopQwenAsr(
  trackUrn: string,
  artist: string,
  title: string,
  plainLyrics: string,
  trackDurationSec?: number,
): Promise<LyricsResult | null> {
  if (!isTauriRuntime()) {
    logLyricsDebug('desktop Qwen skipped: not in Tauri runtime');
    return null;
  }

  try {
    const stream = streamUrl(trackUrn);
    logLyricsDebug('trying desktop Qwen sync', {
      trackUrn,
      artist,
      title,
      stream,
      plainLyricsLength: plainLyrics.length,
    });
    const payload = await invoke<unknown>('qwen_sync_lyrics', {
      streamUrl: stream,
      plainLyrics,
      trackUrn,
      artist,
      title,
    });
    logLyricsDebug('desktop Qwen payload summary', summarizePayloadForDebug(payload));
    const synced = parseQwenPayload(payload, plainLyrics, trackDurationSec);
    if (!synced || synced.length === 0) {
      warnLyricsDebug(
        'desktop Qwen returned payload without usable timings',
        summarizePayloadForDebug(payload),
      );
      return null;
    }

    logLyricsDebug('desktop Qwen sync success', {
      trackUrn,
      lineCount: synced.length,
    });

    return {
      plain: plainLyrics,
      synced,
      source: 'qwen',
    };
  } catch (error) {
    warnLyricsDebug('desktop Qwen sync failed', error);
    return null;
  }
}

async function searchQwenAsr(
  trackUrn: string,
  artist: string,
  title: string,
  plainLyrics: string | null,
  trackDurationSec?: number,
): Promise<LyricsResult | null> {
  if (!ENABLE_QWEN_ASR || !trackUrn || !plainLyrics) return null;

  logLyricsDebug('trying Qwen aligner', {
    trackUrn,
    artist,
    title,
    plainLyricsLength: plainLyrics.length,
  });
  const desktopResult = await searchDesktopQwenAsr(
    trackUrn,
    artist,
    title,
    plainLyrics,
    trackDurationSec,
  );
  if (desktopResult) return desktopResult;
  logLyricsDebug('desktop Qwen unavailable, falling back to backend Qwen route', { trackUrn });

  try {
    const payload = await api<unknown>(`/tracks/${encodeURIComponent(trackUrn)}/lyrics-sync/qwen`, {
      method: 'POST',
      body: JSON.stringify({
        plainLyrics,
        artist,
        title,
      }),
      quietHttpErrors: true,
      timeoutMs: ASR_TIMEOUT_MS + 8000,
    });
    logLyricsDebug('backend Qwen payload summary', summarizePayloadForDebug(payload));
    const synced = parseQwenPayload(payload, plainLyrics, trackDurationSec);
    if (!synced || synced.length === 0) {
      warnLyricsDebug(
        'backend Qwen returned payload without usable timings',
        summarizePayloadForDebug(payload),
      );
      return null;
    }

    logLyricsDebug('backend Qwen sync success', {
      trackUrn,
      lineCount: synced.length,
    });

    return {
      plain: plainLyrics,
      synced,
      source: 'qwen',
    };
  } catch (error) {
    if (error instanceof ApiError) {
      warnLyricsDebug('backend Qwen API failed', {
        trackUrn,
        status: error.status,
        body: error.body,
      });
      return null;
    }
    warnLyricsDebug('backend Qwen sync failed', error);
    return null;
  }
}

export async function searchPlainLyricsAutoTiming(
  trackUrn: string,
  artist: string,
  title: string,
  plainLyrics: string | null,
  signal: AbortSignal,
  trackDurationSec?: number,
): Promise<LyricsResult | null> {
  if (!plainLyrics) return null;

  if (isQwenAsrEnabled()) {
    logLyricsDebug('auto timing provider order: Qwen -> Kroko/comments fallback', { trackUrn });
    const qwen = await searchQwenAsr(trackUrn, artist, title, plainLyrics, trackDurationSec);
    if (qwen) return qwen;
  }

  if (isKrokoAsrEnabled()) {
    logLyricsDebug('trying Kroko ASR fallback', { trackUrn });
    const kroko = await searchKrokoAsr(artist, title, plainLyrics, signal);
    if (kroko) return kroko;
  }

  return null;
}

export async function searchLyrics(
  trackUrn: string,
  scUsername: string,
  scTitle: string,
  options: LyricsSearchOptions = {},
): Promise<LyricsResult | null> {
  const requestedArtist = String(scUsername || '').trim();
  const requestedTitle = String(scTitle || '').trim();
  const uploaderUsername = String(options.uploaderUsername || requestedArtist || '').trim();
  const originalTitle = String(options.originalTitle || requestedTitle || '').trim();
  const requestedTitleVariants = collectTitleVariants(requestedTitle);
  const originalTitleVariants =
    originalTitle !== requestedTitle ? collectTitleVariants(originalTitle) : [];
  const artistAliasHints = collectArtistAliasHints([
    requestedArtist,
    uploaderUsername,
    options.description,
  ]);
  const parsedRequested = splitArtistTitle(requestedTitle);
  const parsedOriginal = splitArtistTitle(originalTitle);
  const extractedTitleHints = collectLooseTitleOnlyCandidates([
    requestedTitle,
    originalTitle,
  ]).slice(0, 4);
  const reuploadCleanTitle =
    extractReuploadCleanTitle(requestedTitle) ?? extractReuploadCleanTitle(originalTitle);
  const decorativeCleanTitle = (() => {
    const requestedDecorative = stripDecorative(requestedTitle);
    if (requestedDecorative && requestedDecorative !== requestedTitle) return requestedDecorative;
    const originalDecorative = stripDecorative(originalTitle);
    return originalDecorative && originalDecorative !== originalTitle ? originalDecorative : null;
  })();
  const requiredTitleTokens = collectRequiredTitleTokens([
    reuploadCleanTitle ?? requestedTitle,
    decorativeCleanTitle ?? originalTitle,
    originalTitle,
  ]);
  const multiArtistTitleParts = splitMultiArtistTitle(reuploadCleanTitle ?? requestedTitle);
  const descriptionArtistHint = options.description
    ? extractArtistFromDescriptionFirstLine(options.description)
    : null;
  const missCacheKey = buildLyricsMissCacheKey(
    trackUrn,
    requestedArtist || uploaderUsername,
    requestedTitle || originalTitle,
  );

  if (!options.forceRefresh) {
    pruneLyricsMissCache();
    const missExpiresAt = lyricsMissCache.get(missCacheKey);
    if (missExpiresAt && missExpiresAt > Date.now()) {
      logLyricsDebug('skipping recent lyrics miss', {
        trackUrn,
        requestedArtist,
        requestedTitle,
      });
      return null;
    }
  }

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const sig = controller.signal;

  try {
    if (!options.forceRefresh) {
      const cachedRaw = await loadLyricsFromCache(trackUrn);
      const cachedVersion =
        cachedRaw && typeof cachedRaw === 'object' && typeof cachedRaw.cacheVersion === 'number'
          ? cachedRaw.cacheVersion
          : 0;
      const cached =
        cachedVersion >= LYRICS_SEARCH_CACHE_VERSION
          ? normalizeLyricsResult(cachedRaw as LyricsResult | null)
          : null;

      if (cached) {
        logLyricsDebug('using cached lyrics result', {
          trackUrn,
          source: cached.source,
          hasPlain: Boolean(cached.plain),
          hasSynced: Boolean(cached.synced?.length),
        });
        return cached;
      }

      if (cachedRaw && cachedVersion < LYRICS_SEARCH_CACHE_VERSION) {
        logLyricsDebug('ignoring legacy lyrics cache entry', {
          trackUrn,
          cachedVersion,
          expectedVersion: LYRICS_SEARCH_CACHE_VERSION,
        });
      }
    }

    const saveMatchedLyrics = async (result: LyricsResult) => {
      lyricsMissCache.delete(missCacheKey);
      await saveLyricsToCache(trackUrn, {
        ...result,
        cacheVersion: LYRICS_SEARCH_CACHE_VERSION,
      });
      return result;
    };

    const priorityTitleOnlyAttempts: string[] = [];
    const seenPriorityTitles = new Set<string>();
    const pushPriorityTitleOnlyAttempt = (title: string) => {
      const trimmedTitle = String(title || '').trim();
      if (!trimmedTitle || !hasStrongTitleOnlyHint(trimmedTitle)) return;
      if (hasMissingRequiredTitleTokens(trimmedTitle, requiredTitleTokens)) return;
      const key = normalizeSearchText(trimmedTitle);
      if (!key || seenPriorityTitles.has(key)) return;
      seenPriorityTitles.add(key);
      priorityTitleOnlyAttempts.push(trimmedTitle);
    };

    for (const titleHint of [
      requestedTitle,
      originalTitle,
      ...requestedTitleVariants,
      ...originalTitleVariants,
      reuploadCleanTitle,
      decorativeCleanTitle,
      ...multiArtistTitleParts,
      stripBrackets(requestedTitle),
      stripBrackets(originalTitle),
      parsedRequested?.[1],
      parsedOriginal?.[1],
      ...extractedTitleHints,
    ]) {
      pushPriorityTitleOnlyAttempt(titleHint || '');
    }

    const runSyncedChain = async (artist: string, title: string) => {
      const trimmedArtist = String(artist || '').trim();
      const trimmedTitle = String(title || '').trim();
      if (!trimmedTitle) return null;
      const profile = buildLyricsSearchProfile(trimmedArtist, trimmedTitle, {
        ...options,
        uploaderUsername,
        originalTitle,
      });
      return searchSyncedParallel(trimmedArtist, trimmedTitle, profile, sig);
    };

    if (requestedTitle) {
      const syncedExact = await runSyncedChain(requestedArtist, requestedTitle);
      if (syncedExact) {
        logLyricsDebug('resolved synced lyrics (exact pair, phase 1)', { trackUrn });
        return await saveMatchedLyrics(syncedExact);
      }

      const strippedRequested = stripBrackets(requestedTitle);
      if (requestedArtist && strippedRequested && strippedRequested !== requestedTitle) {
        const syncedStripped = await runSyncedChain(requestedArtist, strippedRequested);
        if (syncedStripped) {
          logLyricsDebug('resolved synced lyrics (stripped title, phase 1)', { trackUrn });
          return await saveMatchedLyrics(syncedStripped);
        }
      }

      for (const titleVariant of [...requestedTitleVariants, ...originalTitleVariants]) {
        const syncedVariant = await runSyncedChain(requestedArtist, titleVariant);
        if (syncedVariant) {
          logLyricsDebug('resolved synced lyrics (title variant, phase 1)', {
            trackUrn,
            titleVariant,
          });
          return await saveMatchedLyrics(syncedVariant);
        }
      }

      if (requestedArtist) {
        for (const splitTitle of multiArtistTitleParts) {
          const syncedSplit = await runSyncedChain(requestedArtist, splitTitle);
          if (syncedSplit) {
            logLyricsDebug('resolved synced lyrics (multi-title split, phase 1)', {
              trackUrn,
              splitTitle,
            });
            return await saveMatchedLyrics(syncedSplit);
          }

          if (uploaderUsername && uploaderUsername !== requestedArtist) {
            const syncedUploaderSplit = await runSyncedChain(uploaderUsername, splitTitle);
            if (syncedUploaderSplit) {
              logLyricsDebug('resolved synced lyrics (uploader + multi-title split, phase 1)', {
                trackUrn,
                splitTitle,
              });
              return await saveMatchedLyrics(syncedUploaderSplit);
            }
          }

          for (const relatedArtist of multiArtistTitleParts) {
            if (relatedArtist === splitTitle) continue;
            const syncedRelatedSplit = await runSyncedChain(relatedArtist, splitTitle);
            if (syncedRelatedSplit) {
              logLyricsDebug('resolved synced lyrics (split artist + split title, phase 1)', {
                trackUrn,
                relatedArtist,
                splitTitle,
              });
              return await saveMatchedLyrics(syncedRelatedSplit);
            }
          }
        }

        for (const titleAttempt of priorityTitleOnlyAttempts.slice(
          0,
          MAX_PRIORITY_TITLE_ONLY_ATTEMPTS,
        )) {
          const syncedTitleOnly = await runSyncedChain('', titleAttempt);
          if (syncedTitleOnly) {
            logLyricsDebug('resolved synced lyrics (priority title-only, phase 1)', {
              trackUrn,
              titleAttempt,
            });
            return await saveMatchedLyrics(syncedTitleOnly);
          }
        }
      }
    }

    const runChain = async (artist: string, title: string) => {
      const trimmedArtist = String(artist || '').trim();
      const trimmedTitle = String(title || '').trim();
      if (!trimmedTitle) return null;
      const profile = buildLyricsSearchProfile(trimmedArtist, trimmedTitle, {
        ...options,
        uploaderUsername,
        originalTitle,
      });
      return runChainFull(trimmedArtist, trimmedTitle, profile, sig);
    };

    if (requestedTitle) {
      const primaryExactResult = await runChain(requestedArtist, requestedTitle);
      if (primaryExactResult) return await saveMatchedLyrics(primaryExactResult);

      for (const splitTitle of multiArtistTitleParts) {
        const splitResult = await runChain(requestedArtist, splitTitle);
        if (splitResult) return await saveMatchedLyrics(splitResult);

        if (uploaderUsername && uploaderUsername !== requestedArtist) {
          const uploaderSplitResult = await runChain(uploaderUsername, splitTitle);
          if (uploaderSplitResult) return await saveMatchedLyrics(uploaderSplitResult);
        }

        for (const relatedArtist of multiArtistTitleParts) {
          if (relatedArtist === splitTitle) continue;
          const relatedSplitResult = await runChain(relatedArtist, splitTitle);
          if (relatedSplitResult) return await saveMatchedLyrics(relatedSplitResult);
        }
      }

      const strippedRequestedTitle = stripBrackets(requestedTitle);
      if (requestedArtist && strippedRequestedTitle && strippedRequestedTitle !== requestedTitle) {
        const strippedPairResult = await runChain(requestedArtist, strippedRequestedTitle);
        if (strippedPairResult) {
          logLyricsDebug('resolved lyrics via stripped title fallback', {
            trackUrn,
            requestedArtist,
            requestedTitle,
            titleAttempt: strippedRequestedTitle,
          });
          return await saveMatchedLyrics(strippedPairResult);
        }
      }

      for (const titleVariant of [...requestedTitleVariants, ...originalTitleVariants]) {
        const variantResult = await runChain(requestedArtist, titleVariant);
        if (variantResult) {
          logLyricsDebug('resolved lyrics via title variant fallback', {
            trackUrn,
            requestedArtist,
            requestedTitle,
            titleAttempt: titleVariant,
          });
          return await saveMatchedLyrics(variantResult);
        }
      }

      if (requestedArtist) {
        for (const titleAttempt of priorityTitleOnlyAttempts.slice(
          0,
          MAX_PRIORITY_TITLE_ONLY_ATTEMPTS,
        )) {
          const titleOnlyResult = await runChain('', titleAttempt);
          if (titleOnlyResult) {
            logLyricsDebug('resolved lyrics via early title-only fallback', {
              trackUrn,
              requestedArtist,
              requestedTitle,
              titleAttempt,
            });
            return await saveMatchedLyrics(titleOnlyResult);
          }
        }
      }
    }

    const pairAttempts: Array<{ artist: string; title: string }> = [];
    const seenPairs = new Set<string>();
    const pushPairAttempt = (artist: string, title: string) => {
      const trimmedArtist = String(artist || '').trim();
      const trimmedTitle = String(title || '').trim();
      if (!trimmedTitle) return;
      if (hasMissingRequiredTitleTokens(trimmedTitle, requiredTitleTokens)) return;
      const key = `${normalizeSearchText(trimmedArtist)}::${normalizeSearchText(trimmedTitle)}`;
      if (seenPairs.has(key)) return;
      seenPairs.add(key);
      pairAttempts.push({ artist: trimmedArtist, title: trimmedTitle });
    };

    for (const artistAlias of artistAliasHints) {
      pushPairAttempt(artistAlias, requestedTitle);
      if (originalTitle && originalTitle !== requestedTitle) {
        pushPairAttempt(artistAlias, originalTitle);
      }
      if (reuploadCleanTitle) {
        pushPairAttempt(artistAlias, reuploadCleanTitle);
      }
      if (decorativeCleanTitle) {
        pushPairAttempt(artistAlias, decorativeCleanTitle);
      }
      for (const titleHint of extractedTitleHints) {
        pushPairAttempt(artistAlias, titleHint);
      }
    }
    for (const titleHint of extractedTitleHints) {
      if (!hasMissingRequiredTitleTokens(titleHint, requiredTitleTokens)) {
        pushPairAttempt('', titleHint);
      }
      pushPairAttempt(requestedArtist, titleHint);
      if (uploaderUsername && uploaderUsername !== requestedArtist) {
        pushPairAttempt(uploaderUsername, titleHint);
      }
    }
    for (const titleVariant of [...requestedTitleVariants, ...originalTitleVariants]) {
      pushPairAttempt(requestedArtist, titleVariant);
      pushPairAttempt(uploaderUsername, titleVariant);
      if (descriptionArtistHint) pushPairAttempt(descriptionArtistHint, titleVariant);
    }
    if (parsedRequested) {
      pushPairAttempt(parsedRequested[0], parsedRequested[1]);
    }
    for (const splitTitle of multiArtistTitleParts) {
      pushPairAttempt(requestedArtist, splitTitle);
      if (descriptionArtistHint) pushPairAttempt(descriptionArtistHint, splitTitle);
      for (const relatedArtist of multiArtistTitleParts) {
        if (relatedArtist !== splitTitle) {
          pushPairAttempt(relatedArtist, splitTitle);
        }
      }
    }
    if (reuploadCleanTitle) {
      pushPairAttempt(requestedArtist, reuploadCleanTitle);
      pushPairAttempt(uploaderUsername, reuploadCleanTitle);
      if (descriptionArtistHint) pushPairAttempt(descriptionArtistHint, reuploadCleanTitle);
      const parsedReupload = splitArtistTitle(reuploadCleanTitle);
      if (parsedReupload) pushPairAttempt(parsedReupload[0], parsedReupload[1]);
    }
    if (decorativeCleanTitle) {
      const parsedDecorative = splitArtistTitle(decorativeCleanTitle);
      if (parsedDecorative) pushPairAttempt(parsedDecorative[0], parsedDecorative[1]);
      else pushPairAttempt(requestedArtist, decorativeCleanTitle);
    }
    pushPairAttempt(uploaderUsername, originalTitle);
    if (parsedOriginal) {
      pushPairAttempt(parsedOriginal[0], parsedOriginal[1]);
    }
    if (requestedTitle !== originalTitle) {
      pushPairAttempt(requestedArtist, originalTitle);
      pushPairAttempt(uploaderUsername, requestedTitle);
    }

    for (const attempt of pairAttempts) {
      const res = await runChain(attempt.artist, attempt.title);
      if (res) {
        return await saveMatchedLyrics(res);
      }
    }

    const strippedAttempts: Array<{ artist: string; title: string }> = [];
    const seenStrippedPairs = new Set<string>();
    for (const attempt of pairAttempts) {
      const strippedArtist = stripBrackets(attempt.artist);
      const strippedTitle = stripBrackets(attempt.title);
      if (
        (!strippedArtist || strippedArtist === attempt.artist) &&
        strippedTitle === attempt.title
      ) {
        continue;
      }

      const key = `${normalizeSearchText(strippedArtist)}::${normalizeSearchText(strippedTitle)}`;
      if (seenStrippedPairs.has(key)) continue;
      seenStrippedPairs.add(key);
      strippedAttempts.push({ artist: strippedArtist, title: strippedTitle });
    }

    for (const attempt of strippedAttempts) {
      const res = await runChain(attempt.artist, attempt.title);
      if (res) {
        return await saveMatchedLyrics(res);
      }
    }

    const titleOnlyAttempts: string[] = [];
    const seenTitles = new Set<string>();
    const pushTitleOnlyAttempt = (title: string, allowShort = false) => {
      const trimmedTitle = String(title || '').trim();
      if (!trimmedTitle || (!allowShort && !canUseLooseTitleOnly(trimmedTitle))) return;
      if (hasMissingRequiredTitleTokens(trimmedTitle, requiredTitleTokens)) return;
      const key = normalizeSearchText(trimmedTitle);
      if (!key || seenTitles.has(key)) return;
      seenTitles.add(key);
      titleOnlyAttempts.push(trimmedTitle);
    };

    for (const titleHint of collectLooseTitleOnlyCandidates([
      requestedTitle,
      originalTitle,
      ...requestedTitleVariants,
      ...originalTitleVariants,
      parsedRequested?.[1],
      parsedOriginal?.[1],
      ...pairAttempts.map((attempt) => attempt.title),
      ...strippedAttempts.map((attempt) => attempt.title),
    ])) {
      pushTitleOnlyAttempt(titleHint, true);
    }
    pushTitleOnlyAttempt(requestedTitle);
    pushTitleOnlyAttempt(originalTitle);
    if (parsedRequested) {
      pushTitleOnlyAttempt(parsedRequested[1]);
    }
    if (parsedOriginal) {
      pushTitleOnlyAttempt(parsedOriginal[1]);
    }
    for (const attempt of strippedAttempts) {
      pushTitleOnlyAttempt(attempt.title);
    }

    for (const titleAttempt of titleOnlyAttempts.slice(0, MAX_TITLE_ONLY_ATTEMPTS)) {
      const res = await runChain('', titleAttempt);
      if (res) {
        return await saveMatchedLyrics(res);
      }
    }

    for (const titleAttempt of priorityTitleOnlyAttempts.slice(
      0,
      MAX_PRIORITY_TITLE_ONLY_ATTEMPTS,
    )) {
      logLyricsDebug('trying late Genius title-only fallback', {
        trackUrn,
        title: titleAttempt,
      });
      const res = await searchGenius('', titleAttempt, sig);
      if (res) {
        return await saveMatchedLyrics(res);
      }
    }

    const descriptionLyrics = normalizeDescriptionLyricsText(options.description || '');
    if (descriptionLyrics) {
      logLyricsDebug('using SoundCloud description lyrics fallback', {
        trackUrn,
        requestedArtist,
        requestedTitle,
        plainLength: descriptionLyrics.length,
      });
      return await saveMatchedLyrics({
        plain: descriptionLyrics,
        synced: null,
        source: 'soundcloud',
      });
    }

    lyricsMissCache.set(missCacheKey, Date.now() + LYRICS_MISS_CACHE_TTL_MS);
    return null;
  } finally {
    clearTimeout(tid);
  }
}
