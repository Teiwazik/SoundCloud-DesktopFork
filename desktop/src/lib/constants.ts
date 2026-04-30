import { useSettingsStore } from '../stores/settings';

export const API_BASE = import.meta.env.VITE_API_BASE || 'https://api.scdinternal.site';
export const STREAMING_BASE = import.meta.env.VITE_STREAMING_BASE || 'https://stream.scdinternal.site';
export const STREAMING_PREMIUM_BASE =
  import.meta.env.VITE_STREAMING_PREMIUM_BASE || 'https://stream-premium.scdinternal.site';
export const STORAGE_BASE = import.meta.env.VITE_STORAGE_BASE || 'https://storage.scdinternal.site';
export const DEFAULT_API_BASE = API_BASE;
export const LOCAL_API_BASE = 'http://localhost:3000';

export function normalizeApiBase(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(withProtocol);
    return url.origin.replace(/\/$/, '');
  } catch {
    return '';
  }
}

export function getApiBase() {
  const { apiMode } = useSettingsStore.getState();
  if (apiMode === 'custom') {
    return LOCAL_API_BASE;
  }
  return API_BASE;
}

export function buildApiUrl(path: string) {
  return `${getApiBase()}${path}`;
}

export const GITHUB_OWNER = 'Teiwazik';
export const GITHUB_REPO = 'SoundCloud-DesktopFork';
export const GITHUB_REPO_EN = 'SoundCloud-Desktop-EN';
export const APP_VERSION = __APP_VERSION__;

let _staticPort: number | null = null;
let _proxyPort: number | null = null;

export function setServerPorts(staticP: number, proxy: number) {
  _staticPort = staticP;
  _proxyPort = proxy;
}

export function getStaticPort(): number | null {
  return _staticPort;
}

export function getProxyPort(): number | null {
  return _proxyPort;
}
