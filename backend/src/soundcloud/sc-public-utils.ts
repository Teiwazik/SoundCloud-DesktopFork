export interface ScTranscodingInfo {
  url: string;
  preset: string;
  duration: number;
  snipped?: boolean;
  format: { protocol: string; mime_type: string };
  quality: string;
}

export interface ScResolvedTrack {
  permalink_url?: string;
  track_authorization?: string;
  media?: { transcodings?: ScTranscodingInfo[] };
}

interface HydrationEntry {
  hydratable: string;
  data: any;
}

export interface CookieHydrationData {
  sound: {
    media?: { transcodings?: ScTranscodingInfo[] };
    track_authorization?: string;
  } | null;
  clientId: string | null;
}

const FORMAT_TO_PRESETS: Record<string, string[]> = {
  hls_aac_160: ['aac_160k'],
  hls_mp3_128: ['mp3_1_0'],
  http_mp3_128: ['mp3_1_0'],
  hls_opus_64: ['opus_0_0'],
};

const PRESET_FALLBACK_ORDER = ['mp3_1_0', 'aac_160k', 'opus_0_0', 'abr_sq'];

const MIME_TO_CONTENT_TYPE: Record<string, string> = {
  'audio/mpeg': 'audio/mpeg',
  'audio/mp4; codecs="mp4a.40.2"': 'audio/mp4',
  'audio/ogg; codecs="opus"': 'audio/ogg',
  'audio/mpegurl': 'audio/mpeg',
};

export function proxyTarget(
  proxyUrl: string,
  targetUrl: string,
  extra: Record<string, string> = {},
): { url: string; headers: Record<string, string> } {
  if (!proxyUrl) {
    return { url: targetUrl, headers: extra };
  }

  return {
    url: proxyUrl,
    headers: { ...extra, 'X-Target': Buffer.from(targetUrl).toString('base64') },
  };
}

export function pickTranscoding(
  transcodings: ScTranscodingInfo[],
  preferredFormat?: string,
): ScTranscodingInfo | null {
  const candidates = transcodings.filter((t) => !t.format?.protocol?.includes('encrypted') && !t.snipped && !t.url.includes("/preview"));
  if (!candidates.length) return null;

  if (preferredFormat) {
    const presets = FORMAT_TO_PRESETS[preferredFormat];
    if (presets) {
      const match = candidates.find((t) => presets.includes(t.preset));
      if (match) return match;
    }
  }

  for (const preset of PRESET_FALLBACK_ORDER) {
    const match = candidates.find((t) => t.preset === preset);
    if (match) return match;
  }

  return candidates[0];
}

export function getContentTypeForMime(mimeType: string): string {
  return MIME_TO_CONTENT_TYPE[mimeType] ?? 'application/octet-stream';
}

export function parseM3u8(
  content: string,
  baseUrl: string,
): { initUrl: string | null; segmentUrls: string[] } {
  const lines = content.split('\n').map((l) => l.trim());
  let initUrl: string | null = null;
  const segmentUrls: string[] = [];
  const base = new URL(baseUrl);

  for (const line of lines) {
    const mapMatch = line.match(/#EXT-X-MAP:URI="([^"]+)"/);
    if (mapMatch) {
      initUrl = resolveSegmentUrl(mapMatch[1], base);
      continue;
    }
    if (line.startsWith('#') || !line) continue;
    segmentUrls.push(resolveSegmentUrl(line, base));
  }

  return { initUrl, segmentUrls };
}

export function resolveSegmentUrl(url: string, base: URL): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return new URL(url, base).href;
}

export function parseCookieHeader(cookieHeader: string): Record<string, string> {
  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, part) => {
      const idx = part.indexOf('=');
      if (idx === -1) return acc;
      const key = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (!key) return acc;
      acc[key] = value;
      return acc;
    }, {});
}

export function getCookieValue(cookieHeader: string, name: string): string | null {
  const value = parseCookieHeader(cookieHeader)[name];
  return value ? decodeURIComponent(value) : null;
}

function parseHydrationEntries(html: string): HydrationEntry[] | null {
  const marker = 'window.__sc_hydration =';
  const idx = html.indexOf(marker);
  if (idx === -1) return null;

  let pos = idx + marker.length;
  while (pos < html.length && html[pos] !== '[') {
    if (!/\s/.test(html[pos])) return null;
    pos++;
  }
  if (pos >= html.length) return null;

  let depth = 1;
  let inStr = false;
  let esc = false;
  let i = pos + 1;

  while (i < html.length && depth > 0) {
    const ch = html[i];
    if (!inStr) {
      if (ch === '"' && !esc) inStr = true;
      else if (ch === '[') depth++;
      else if (ch === ']') depth--;
    } else if (ch === '"' && !esc) {
      inStr = false;
    }
    esc = !esc && ch === '\\';
    i++;
  }

  try {
    return JSON.parse(html.substring(pos, i)) as HydrationEntry[];
  } catch {
    return null;
  }
}

function findHydrationData<T>(entries: HydrationEntry[], hydratable: string): T | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].hydratable === hydratable) {
      return (entries[i].data as T) ?? null;
    }
  }
  return null;
}

export function extractClientIdFromHydration(html: string): string | null {
  const entries = parseHydrationEntries(html);
  return entries ? findHydrationData<{ id?: string }>(entries, 'apiClient')?.id ?? null : null;
}

export function extractCookieHydrationData(html: string): CookieHydrationData | null {
  const entries = parseHydrationEntries(html);
  if (!entries) return null;

  return {
    sound: findHydrationData<CookieHydrationData['sound']>(entries, 'sound'),
    clientId: findHydrationData<{ id?: string }>(entries, 'apiClient')?.id ?? null,
  };
}
