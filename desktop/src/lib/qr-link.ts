import { api } from './api';

/**
 * QR-link API — single-use токен для переноса сессии между устройствами.
 *
 * pull: caller (без сессии) показывает QR, другое (залогиненное) сканирует и пушит.
 * push: caller (залогинен) показывает QR, другое (без сессии) сканирует и забирает.
 *
 * Результат claim'а в обе стороны — новая сессия на устройстве, у которого её не было.
 */

export interface CreateLinkResponse {
  linkRequestId: string;
  claimToken: string;
  expiresAt: string;
}

export interface LinkStatusResponse {
  status: 'pending' | 'claimed' | 'failed' | 'expired';
  mode: 'pull' | 'push';
  sessionId?: string;
  error?: string;
}

export interface ClaimLinkResponse {
  sessionId: string;
  mode: 'pull' | 'push';
}

export async function createLinkRequest(mode: 'pull' | 'push'): Promise<CreateLinkResponse> {
  return api<CreateLinkResponse>('/auth/link/create', {
    method: 'POST',
    body: JSON.stringify({ mode }),
  });
}

export async function claimLinkRequest(claimToken: string): Promise<ClaimLinkResponse> {
  return api<ClaimLinkResponse>('/auth/link/claim', {
    method: 'POST',
    body: JSON.stringify({ claimToken }),
  });
}

export async function getLinkStatus(linkRequestId: string): Promise<LinkStatusResponse> {
  return api<LinkStatusResponse>(
    `/auth/link/status?id=${encodeURIComponent(linkRequestId)}`,
  );
}

/**
 * Encoded payload для QR. Это deep-link с claimToken, чтобы мобильный клиент
 * мог автоматически открыть приложение и заклеймить.
 *
 * Формат: scd://link?token=<claimToken>&mode=<pull|push>
 */
export function encodeQrPayload(claimToken: string, mode: 'pull' | 'push'): string {
  const params = new URLSearchParams({ token: claimToken, mode });
  return `scd://link?${params.toString()}`;
}
