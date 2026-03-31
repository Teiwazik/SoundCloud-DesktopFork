import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import i18n from './i18n';
import { ApiError } from './lib/api';
import { setServerPorts } from './lib/constants';
import { isTauriRuntime } from './lib/runtime';
import './lib/audio';
import './index.css';
import { useSettingsStore } from './stores/settings';

useSettingsStore.persist.onFinishHydration((state) => {
  if (state.language && state.language !== i18n.language) {
    i18n.changeLanguage(state.language);
  }
  if (!isTauriRuntime()) return;
  invoke('audio_set_eq', { enabled: state.eqEnabled, gains: state.eqGains }).catch(console.error);
  invoke('audio_set_normalization', { enabled: state.normalizeVolume }).catch(console.error);
});


if (import.meta.env.DEV && import.meta.env.VITE_REACT_SCAN === '1') {
  const script = document.createElement('script');
  script.src = 'https://unpkg.com/react-scan/dist/auto.global.js';
  script.crossOrigin = 'anonymous';
  document.head.appendChild(script);
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      gcTime: 1000 * 60 * 2,
      retry: (failureCount, error) => {
        if (error instanceof ApiError) {
          if (error.status === 429) return false;
          if (error.status >= 400 && error.status < 500) return false;
        }
        return failureCount < 1;
      },
      retryDelay: (attempt, error) => {
        if (error instanceof ApiError && error.retryAfterMs) {
          return Math.min(error.retryAfterMs, 10000);
        }
        return Math.min(1000 * 2 ** attempt, 5000);
      },
      refetchOnWindowFocus: false,
    },
  },
});

async function registerServiceWorker(proxyPort: number) {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register(`/sw.js?port=${proxyPort}`);
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
          once: true,
        }),
      );
    }
  } catch (e) {
    console.warn('[SW] Registration failed, running without proxy SW:', e);
  }
}

async function bootstrap() {
  let staticPort = 1420;
  let proxyPort = 1420;

  let tauriRuntime = isTauriRuntime();
  if (!tauriRuntime) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    tauriRuntime = isTauriRuntime();
  }

  if (tauriRuntime) {
    await Promise.all([
      import('./lib/scproxy'),
      import('./lib/discord'),
      import('./lib/tray'),
    ]);
    try {
      const ports = await invoke<[number, number]>('get_server_ports');
      staticPort = ports[0];
      proxyPort = ports[1];
    } catch (e) {
      console.warn('Failed to get Tauri ports. Using defaults:', e);
    }
  } else {
    console.warn('[Bootstrap] Browser mode detected (without Tauri runtime).');
    console.warn('[Bootstrap] For full app behavior run `pnpm dev:mcp` and use the Tauri window.');
  }

  setServerPorts(staticPort, proxyPort);

  if (tauriRuntime) {
    await registerServiceWorker(proxyPort);
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </React.StrictMode>,
  );
}

void bootstrap();
