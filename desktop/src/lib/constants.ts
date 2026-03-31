import { useSettingsStore } from '../stores/settings';

export const DEFAULT_API_BASE = import.meta.env.VITE_API_BASE || 'https://api.soundcloud.su';

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
  const { apiMode, customApiKey } = useSettingsStore.getState();
  if (apiMode === 'custom' && customApiKey.trim()) {
    return `${DEFAULT_API_BASE}?client_id=${customApiKey.trim()}`;
  }
  return DEFAULT_API_BASE;
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
