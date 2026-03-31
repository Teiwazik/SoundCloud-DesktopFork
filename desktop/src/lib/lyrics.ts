import { isTauri } from '@tauri-apps/api/core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { saveLyricsToCache, loadLyricsFromCache } from './cache';

const LRCLIB_API = 'https://lrclib.net/api';
const LYRICS_OVH_API = 'https://api.lyrics.ovh/v1';
const NCM_API = 'https://ncm.nekohasegawa.com';
const TEXTYL_API = 'https://api.textyl.co/api/lyrics';
const MUSIXMATCH_API = 'https://apic-desktop.musixmatch.com/ws/1.1';
const TIMEOUT_MS = 10000;
const ENABLE_NCM = (import.meta.env.VITE_LYRICS_NCM || '').toLowerCase() === 'true';
export interface LyricLine {
  time: number;
  text: string;
}

export type LyricsSource = 'lrclib' | 'netease' | 'musixmatch' | 'genius' | 'textyl';

export interface LyricsResult {
  plain: string | null;
  synced: LyricLine[] | null;
  source: LyricsSource;
}

let musixmatchTokenPromise: Promise<string | null> | null = null;

async function requestText(url: string, signal?: AbortSignal): Promise<string> {
  if (!isTauri()) {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  }

  try {
    const res = await tauriFetch(url, { method: 'GET', signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  }
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
  if (!subtitleBody) return null;

  try {
    const parsed = JSON.parse(subtitleBody) as Array<{
      text?: string;
      time?: { total?: number };
    }>;

    const lines = parsed
      .map((entry) => ({
        text: String(entry?.text || '').trim(),
        time: Number(entry?.time?.total),
      }))
      .filter((line) => line.text && Number.isFinite(line.time));

    return lines.length > 0 ? lines : null;
  } catch {
    return null;
  }
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
  const lines: LyricLine[] = [];
  for (const raw of lrc.split('\n')) {
    const m = raw.match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\]\s*(.*)/);
    if (!m) continue;
    const time = +m[1] * 60 + +m[2] + +m[3].padEnd(3, '0') / 1000;
    const text = m[4].trim();
    if (text) lines.push({ time, text });
  }
  return lines;
}

function toResultLrclib(entry: {
  plainLyrics?: string;
  syncedLyrics?: string;
}): LyricsResult | null {
  const plain = entry.plainLyrics || null;
  const synced = entry.syncedLyrics ? parseLRC(entry.syncedLyrics) : null;
  if (!plain && !synced) return null;
  return { plain, synced, source: 'lrclib' };
}

/** Remove feat/remix/brackets/special chars */
function clean(s: string): string {
  return s
    .replace(/\(feat\.?[^)]*\)/gi, '')
    .replace(/\(ft\.?[^)]*\)/gi, '')
    .replace(/\[.*?\]/g, '')
    .replace(
      /\(.*?(remix|edit|version|mix|cover|live|acoustic|instrumental|original|prod).*?\)/gi,
      '',
    )
    .replace(/\s+(feat\.?|ft\.?|featuring|prod\.?)\b.*$/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Aggressively strip all parentheses and brackets */
function stripBrackets(s: string): string {
  return s
    .replace(/\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip everything non-alphanumeric (keep unicode letters) */
function alphaOnly(s: string): string {
  return s
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
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

async function lrclibFetch(
  params: Record<string, string>,
  signal: AbortSignal,
): Promise<LyricsResult | null> {
  try {
    const url = `${LRCLIB_API}/search?${new URLSearchParams(params)}`;
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.length) return null;
    return toResultLrclib(data[0]);
  } catch {
    return null;
  }
}

async function searchLrclib(
  artist: string,
  title: string,
  signal: AbortSignal,
): Promise<LyricsResult | null> {
  // 1. Exact
  let r = await lrclibFetch({ artist_name: artist, track_name: title }, signal);
  if (r) return r;
  // 2. Cleaned
  const ca = clean(artist);
  const ct = clean(title);
  r = await lrclibFetch({ artist_name: ca, track_name: ct }, signal);
  if (r) return r;
  // 3. Alpha-only
  const aa = alphaOnly(ca);
  const at = alphaOnly(ct);
  if (aa !== ca || at !== ct) {
    r = await lrclibFetch({ artist_name: aa, track_name: at }, signal);
    if (r) return r;
  }
  // 4. Free-text q=
  r = await lrclibFetch({ q: alphaOnly(`${artist} ${title}`) }, signal);
  return r;
}

// ── NetEase Cloud Music ───────────────────────────────────────

async function searchNetease(
  artist: string,
  title: string,
  signal: AbortSignal,
): Promise<LyricsResult | null> {
  try {
    const q = encodeURIComponent(`${clean(artist)} ${clean(title)}`);
    const searchRes = await fetch(`${NCM_API}/search?keywords=${q}&type=1`, { signal });
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    const id = searchData?.result?.songs?.[0]?.id;
    if (!id) return null;

    const lrcRes = await fetch(`${NCM_API}/lyric?id=${id}`, { signal });
    if (!lrcRes.ok) return null;
    const lrcData = await lrcRes.json();

    const syncedLrc = lrcData?.lrc?.lyric;
    const tlyric = lrcData?.tlyric?.lyric; // Translated (optional fallback)

    if (syncedLrc && syncedLrc.length > 20) {
      return { plain: null, synced: parseLRC(syncedLrc), source: 'netease' };
    }
    if (tlyric && tlyric.length > 20) {
      return { plain: tlyric, synced: null, source: 'netease' };
    }
    return null;
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
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const data = await res.json();
    const text: string | undefined = data?.lyrics;
    if (!text || text.length < 20) return null;
    // Filter out "We're working on ..." placeholder
    if (/we.re working on|lyrics not available/i.test(text)) return null;
    return { plain: text.trim(), synced: null, source: 'musixmatch' };
  } catch {
    return null;
  }
}

// ── Direct Genius Scraper ────────────────────────────────────────

async function searchGenius(
  artist: string,
  title: string,
  _signal: AbortSignal,
): Promise<LyricsResult | null> {
  try {
    const q = encodeURIComponent(`${clean(artist)} ${clean(title)}`);
    const searchUrl = `https://genius.com/api/search/multi?per_page=5&q=${q}`;

    // Tauri Fetch ignores CORS
    const searchRes = await tauriFetch(searchUrl, { method: 'GET' });
    if (!searchRes.ok) return null;

    const searchData = await searchRes.json();
    let hitUrl = null;

    // Find the first song hit
    for (const section of searchData?.response?.sections || []) {
      if (section.type === 'song') {
        const hits = section.hits || [];
        if (hits.length > 0) {
          hitUrl = hits[0].result?.url;
          break;
        }
      }
    }

    if (!hitUrl) return null;

    // Fetch HTML
    const htmlRes = await tauriFetch(hitUrl, { method: 'GET' });
    if (!htmlRes.ok) return null;
    const html = await htmlRes.text();

    // Parse the HTML DOM for lyrics
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const containers = doc.querySelectorAll('[data-lyrics-container="true"]');

    if (!containers || containers.length === 0) return null;

    let plainLyrics = '';
    containers.forEach((container) => {
      // Replace <br> and <br/> with newline
      container.innerHTML = container.innerHTML.replace(/<br\s*\/?>/gi, '\n');
      plainLyrics += container.textContent + '\n';
    });

    plainLyrics = plainLyrics.trim();

    // Clean Genius-specific headers (Contributors, Title Lyrics, [Текст песни])
    plainLyrics = plainLyrics
      .replace(/^\d+\s*Contributors/i, '')
      .replace(/^[^\n]*?Lyrics/i, '')
      .replace(/^\[Текст песни.*?\]/i, '')
      .trim();

    if (plainLyrics.length > 20) {
      return { plain: plainLyrics, synced: null, source: 'genius' };
    }

    return null;
  } catch (err) {
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
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const data = await res.json();
    // Textyl returns an array of objects for synced, or sometimes just objects with `seconds` and `lyrics`
    if (Array.isArray(data) && data.length > 0) {
      const lines: LyricLine[] = data
        .map((d: any) => ({
          time: Number(d.seconds),
          text: String(d.lyrics),
        }))
        .filter((l) => !isNaN(l.time) && l.text);
      if (lines.length > 0) {
        return { plain: null, synced: lines, source: 'textyl' };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ── Main export ───────────────────────────────────────────────

export async function searchLyrics(
  trackUrn: string,
  scUsername: string,
  scTitle: string,
): Promise<LyricsResult | null> {
  const cached = await loadLyricsFromCache(trackUrn);
  if (cached) {
    return cached;
  }

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const sig = controller.signal;

  try {
    const parsed = splitArtistTitle(scTitle);
    const artist = parsed ? parsed[0] : scUsername;
    const title = parsed ? parsed[1] : scTitle;

    const runChain = async (a: string, t: string) => {
      let r = await searchLrclib(a, t, sig);
      if (r) return r;
      if (ENABLE_NCM) {
        r = await searchNetease(a, t, sig);
        if (r) return r;
      }
      r = await searchMusixmatchSynced(a, t, sig);
      if (r) return r;
      r = await searchTextyl(a, t, sig);
      if (r) return r;
      r = await searchMusixmatch(a, t, sig);
      if (r) return r;
      r = await searchGenius(a, t, sig);
      if (r) return r;
      return null;
    };

    let res = await runChain(artist, title);
    if (res) {
      await saveLyricsToCache(trackUrn, res);
      return res;
    }

    if (parsed) {
      res = await runChain(scUsername, scTitle);
      if (res) {
        await saveLyricsToCache(trackUrn, res);
        return res;
      }
    }

    // Fallback: title-only search
    if (artist !== '') {
      res = await runChain('', title);
      if (res) {
        await saveLyricsToCache(trackUrn, res);
        return res;
      }

      if (scTitle !== title) {
        res = await runChain('', scTitle);
        if (res) {
          await saveLyricsToCache(trackUrn, res);
          return res;
        }
      }
    }

    // Fallback: Aggressively strip all brackets and parentheses
    const artistNoBrackets = stripBrackets(artist);
    const titleNoBrackets = stripBrackets(title);

    if (titleNoBrackets !== title || artistNoBrackets !== artist) {
      if (artistNoBrackets && titleNoBrackets) {
        res = await runChain(artistNoBrackets, titleNoBrackets);
        if (res) {
          await saveLyricsToCache(trackUrn, res);
          return res;
        }
      }

      if (titleNoBrackets) {
        res = await runChain('', titleNoBrackets);
        if (res) {
          await saveLyricsToCache(trackUrn, res);
          return res;
        }
      }
    }

    return null;
  } finally {
    clearTimeout(tid);
  }
}
