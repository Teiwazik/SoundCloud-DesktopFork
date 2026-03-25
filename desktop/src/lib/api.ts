import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isTauri } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { useSettingsStore } from '../stores/settings';
import { API_BASE } from './constants';

let sessionId: string | null = null;
let rateLimitUntil = 0;
let rateLimitToastAt = 0;

const RATE_LIMIT_FALLBACK_MS = 3000;
const RATE_LIMIT_TOAST_COOLDOWN_MS = 15000;

export function setSessionId(id: string | null) {
  sessionId = id;
}

export function getSessionId() {
  return sessionId;
}

async function requestWithFallback(input: string, init: RequestInit): Promise<Response> {
  if (!isTauri()) {
    return await fetch(input, init);
  }

  try {
    return await tauriFetch(input, init);
  } catch {
    return await fetch(input, init);
  }
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;

  const secs = Number(header);
  if (Number.isFinite(secs) && secs > 0) {
    return Math.floor(secs * 1000);
  }

  const dateTs = Date.parse(header);
  if (!Number.isNaN(dateTs)) {
    const diff = dateTs - Date.now();
    return diff > 0 ? diff : null;
  }

  return null;
}

async function waitForRateLimitWindow() {
  const waitMs = rateLimitUntil - Date.now();
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

function applyRateLimitWindow(retryAfterMs: number | null) {
  const waitMs = Math.max(retryAfterMs ?? RATE_LIMIT_FALLBACK_MS, 500);
  const until = Date.now() + waitMs;
  if (until > rateLimitUntil) {
    rateLimitUntil = until;
  }

  if (Date.now() - rateLimitToastAt > RATE_LIMIT_TOAST_COOLDOWN_MS) {
    rateLimitToastAt = Date.now();
    toast.error('Too many requests, slowing down');
  }
}

export async function api<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  await waitForRateLimitWindow();

  const headers = new Headers(options.headers);
  if (sessionId) {
    headers.set('x-session-id', sessionId);
  }
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await requestWithFallback(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
    const body = await res.text();
    if (res.status === 429) {
      applyRateLimitWindow(retryAfterMs);
    }

    const err = new ApiError(res.status, body, retryAfterMs);
    if (res.status >= 500) {
      toast.error(`Server error (${res.status})`);
    } else if (res.status === 401) {
      toast.error('Session expired');
    } else if (res.status === 429) {
      // handled via applyRateLimitWindow to avoid toast spam
    } else if (res.status >= 400) {
      try {
        const parsed = JSON.parse(body);
        toast.error(parsed.message || parsed.error || `Error ${res.status}`);
      } catch {
        toast.error(`Error ${res.status}`);
      }
    }
    console.error(`HTTP ERROR: url: ${path}, `, err);
    throw err;
  }

  const contentType = res.headers.get('content-type');
  if (contentType?.includes('application/json')) {
    return res.json();
  }
  return res.text() as T;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: string,
    public retryAfterMs: number | null = null,
  ) {
    super(`API ${status}: ${body}`);
    this.name = 'ApiError';
  }
}

export function streamUrl(trackUrn: string, format = 'http_mp3_128') {
  const params = new URLSearchParams({ format });
  if (useSettingsStore.getState().highQualityStreaming) {
    params.set('hq', 'true');
  }
  if (sessionId) {
    params.set('session_id', sessionId);
  }
  return `${API_BASE}/tracks/${encodeURIComponent(trackUrn)}/stream?${params.toString()}`;
}

export interface TrackComment {
  id: number;
  body: string;
  created_at: string;
  timestamp: number;
  user: {
    urn: string;
    username: string;
    avatar_url: string;
  };
}

export async function getTrackComments(trackUrn: string): Promise<TrackComment[]> {
  try {
    const urnParts = trackUrn.split(':');
    const id = urnParts[urnParts.length - 1]; // get the numeric ID part
    const res = await api<{ collection: TrackComment[] }>(`/tracks/${id}/comments?limit=200&offset=0&threaded=0`);
    return res.collection || [];
  } catch (e) {
    console.error('Failed to fetch comments', e);
    return [];
  }
}
