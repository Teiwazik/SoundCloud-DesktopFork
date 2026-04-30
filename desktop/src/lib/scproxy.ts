import { getProxyPort } from './constants';
import { isTauriRuntime } from './runtime';

const WHITELIST = [
  'localhost',
  '127.0.0.1',
  'tauri.localhost',
  'scproxy.localhost',
  'proxy.scdinternal.site',
  'api.scdinternal.site',
  'stream.scdinternal.site',
  'stream-premium.scdinternal.site',
  'storage.scdinternal.site',
  'unpkg.com',
];
const IS_WINDOWS = navigator.userAgent.includes('Windows');
const ENABLED = isTauriRuntime();

function isWhitelisted(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return WHITELIST.some((w) => h === w || h.endsWith(`.${w}`));
  } catch {
    return true;
  }
}

function scproxyUrl(url: string): string {
  const encoded = btoa(url);
  const proxyPort = getProxyPort();
  if (IS_WINDOWS && proxyPort) {
    return `http://127.0.0.1:${proxyPort}/p/${encoded}`;
  }
  return IS_WINDOWS ? url : `scproxy://localhost/${encoded}`;
}

type ProxyImage = HTMLImageElement & { __origSrc?: string; __origRetryDone?: boolean };

// Hook <img>.src — store original URL to enable retry on error
const imgSrcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
Object.defineProperty(HTMLImageElement.prototype, 'src', {
  set(url: string) {
    if (ENABLED && url?.startsWith('http') && !isWhitelisted(url)) {
      const img = this as ProxyImage;
      img.__origSrc = url;
      img.__origRetryDone = false;
      img.style.display = '';
      url = scproxyUrl(url);
    }
    imgSrcDesc.set!.call(this, url);
  },
  get() {
    return imgSrcDesc.get!.call(this);
  },
});

// Global: hide broken images (proxy error, CDN blocked, etc.)
document.addEventListener(
  'error',
  (e) => {
    if (e.target instanceof HTMLImageElement) {
      const img = e.target as ProxyImage;
      const current = img.currentSrc || img.src;
      if (!img.__origRetryDone && img.__origSrc && (current.includes('scproxy.localhost') || current.startsWith('scproxy://'))) {
        img.__origRetryDone = true;
        img.style.display = '';
        imgSrcDesc.set!.call(img, img.__origSrc);
        return;
      }
      img.style.display = 'none';
    }
  },
  true,
);

// Hook fetch()
const origFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (!ENABLED) {
    return origFetch(input, init);
  }

  let originalUrl: string | null = null;
  let proxiedInput: RequestInfo | URL = input;
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const canFallback = method === 'GET' || method === 'HEAD';

  if (typeof input === 'string' && input.startsWith('http') && !isWhitelisted(input)) {
    originalUrl = input;
    proxiedInput = scproxyUrl(input);
  } else if (input instanceof URL && input.protocol.startsWith('http') && !isWhitelisted(input.toString())) {
    originalUrl = input.toString();
    proxiedInput = scproxyUrl(originalUrl);
  } else if (input instanceof Request && input.url.startsWith('http') && !isWhitelisted(input.url)) {
    originalUrl = input.url;
    proxiedInput = new Request(scproxyUrl(input.url), input);
  }

  if (!originalUrl) {
    return origFetch(input, init);
  }

  try {
    const res = await origFetch(proxiedInput, init);
    if (canFallback && res.status >= 500) {
      return origFetch(originalUrl, init);
    }
    return res;
  } catch (error) {
    if (canFallback) {
      return origFetch(originalUrl, init);
    }
    throw error;
  }
}) as typeof fetch;

export {};
