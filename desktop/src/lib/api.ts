import { isTauri } from '@tauri-apps/api/core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { toast } from 'sonner';
import i18n from '../i18n';
import { useAppStatusStore } from '../stores/app-status';
import { useSettingsStore } from '../stores/settings';
import { waitForAuthHydration } from './auth-hydration';
import { buildApiUrl, STREAMING_BASE } from './constants';

let sessionId: string | null = null;
let rateLimitUntil = 0;
let rateLimitToastAt = 0;
let sessionExpiredToastAt = 0;
let sessionExpiredHandler: (() => void) | null = null;
let unauthorizedHandler: (() => void) | null = null;
let sessionInvalidated = false;

const RATE_LIMIT_FALLBACK_MS = 3000;
const RATE_LIMIT_TOAST_COOLDOWN_MS = 15000;
const SESSION_EXPIRED_TOAST_COOLDOWN_MS = 20000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

export function setSessionId(id: string | null) {
  sessionId = id;
  if (id) {
    sessionInvalidated = false;
  }
}

export function getSessionId() {
  return sessionId;
}

export function setSessionExpiredHandler(handler: (() => void) | null) {
  sessionExpiredHandler = handler;
}

export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler;
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

function createTimedSignal(sourceSignal: AbortSignal | null | undefined, timeoutMs: number) {
  const controller = new AbortController();

  const forwardAbort = () => controller.abort();
  if (sourceSignal) {
    if (sourceSignal.aborted) {
      controller.abort();
    } else {
      sourceSignal.addEventListener('abort', forwardAbort, { once: true });
    }
  }

  const timer = setTimeout(() => controller.abort(), timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (sourceSignal) {
        sourceSignal.removeEventListener('abort', forwardAbort);
      }
    },
  };
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

function showSessionExpiredToast() {
  if (Date.now() - sessionExpiredToastAt <= SESSION_EXPIRED_TOAST_COOLDOWN_MS) {
    return;
  }

  sessionExpiredToastAt = Date.now();
  toast.error(i18n.t('auth.sessionExpired'), {
    action: {
      label: i18n.t('auth.reloginNow'),
      onClick: () => sessionExpiredHandler?.(),
    },
  });
}

function handleUnauthorized() {
  if (sessionInvalidated) {
    return false;
  }

  sessionInvalidated = true;
  unauthorizedHandler?.();
  return true;
}

export async function api<T = unknown>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { quietHttpErrors = false, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, ...requestOptions } = options;
  await waitForAuthHydration();
  await waitForRateLimitWindow();

  const headers = new Headers(requestOptions.headers);
  if (sessionId) {
    headers.set('x-session-id', sessionId);
  }
  if (!headers.has('Content-Type') && requestOptions.body) {
    headers.set('Content-Type', 'application/json');
  }

  let res: Response;
  const timed = createTimedSignal(requestOptions.signal, timeoutMs);
  try {
    res = await requestWithFallback(buildApiUrl(path), {
      ...requestOptions,
      headers,
      signal: timed.signal,
    });
    useAppStatusStore.getState().setBackendReachable(true);
  } catch (error) {
    useAppStatusStore.getState().setBackendReachable(false);
    throw error;
  } finally {
    timed.cleanup();
  }

  if (!res.ok) {
    const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
    const body = await res.text();
    if (res.status === 429) {
      applyRateLimitWindow(retryAfterMs);
    }

    const err = new ApiError(res.status, body, retryAfterMs);
    const shouldSurfaceUnauthorized = res.status !== 401 || handleUnauthorized();
    if (!quietHttpErrors) {
      if (res.status >= 500) {
        toast.error(`Server error (${res.status})`);
      } else if (res.status === 401 && shouldSurfaceUnauthorized) {
        showSessionExpiredToast();
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
      if (res.status !== 401 || shouldSurfaceUnauthorized) {
        console.error(`HTTP ERROR: url: ${path}, `, err);
      }
    }
    throw err;
  }

  const contentType = res.headers.get('content-type');
  useAppStatusStore.getState().setSoundcloudBlocked(false);
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

export function streamUrl(
  trackUrn: string,
  format = 'http_mp3_128',
  hqOverride: boolean | null = null,
) {
  const params = new URLSearchParams({ format });
  const shouldUseHq = hqOverride ?? useSettingsStore.getState().highQualityStreaming;
  if (shouldUseHq) {
    params.set('hq', 'true');
  }
  if (sessionId) {
    params.set('session_id', sessionId);
  }
  return `${STREAMING_BASE}/stream/${encodeURIComponent(trackUrn)}?${params.toString()}`;
}

export type ApiRequestOptions = RequestInit & {
  quietHttpErrors?: boolean;
  timeoutMs?: number;
};

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
    const res = await api<{ collection: TrackComment[] }>(
      `/tracks/${id}/comments?limit=200&offset=0&threaded=0`,
    );
    return res.collection || [];
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      return [];
    }
    console.error('Failed to fetch comments', e);
    return [];
  }
}
