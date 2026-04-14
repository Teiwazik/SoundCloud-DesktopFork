import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import React from 'react';
import ReactDOM, { type Root } from 'react-dom/client';
import App from './App';
import i18n from './i18n';
import { ApiError } from './lib/api';
import './lib/app-visibility';
import { setServerPorts } from './lib/constants';
import { isTauriRuntime } from './lib/runtime';
import './lib/audio';
import './index.css';
import { getEffectivePitchSemitones, usePlayerStore } from './stores/player';
import { useSettingsStore } from './stores/settings';

useSettingsStore.persist.onFinishHydration((state) => {
  if (state.language && state.language !== i18n.language) {
    i18n.changeLanguage(state.language);
  }
  if (!isTauriRuntime()) return;
  invoke('audio_set_eq', { enabled: state.eqEnabled, gains: state.eqGains }).catch(console.error);
  invoke('audio_set_normalization', { enabled: state.normalizeVolume }).catch(console.error);
  invoke('save_framerate_config', {
    target: state.targetFramerate,
    unlocked: state.unlockFramerate,
  }).catch(console.error);
});

function syncHydratedPlayerAudioState(state = usePlayerStore.getState()) {
  if (!isTauriRuntime()) return;

  invoke('audio_set_playback_rate', { playbackRate: state.playbackRate }).catch(console.error);
  invoke('audio_set_pitch', {
    pitchSemitones: getEffectivePitchSemitones(
      state.playbackRate,
      state.pitchControlMode,
      state.pitchSemitones,
    ),
  }).catch(console.error);
}

if (usePlayerStore.persist.hasHydrated()) {
  syncHydratedPlayerAudioState();
}

usePlayerStore.persist.onFinishHydration((state) => {
  syncHydratedPlayerAudioState(state);
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

type RootWindow = Window & {
  __scdRoot?: Root;
  __scdDevPerfTimelineCleanup?: {
    intervalId: number;
    onVisibilityChange: () => void;
    onPageHide: () => void;
  };
};

// React StrictMode doubles mounts/effects in dev and tanks WebKitGTK FPS in tauri dev.
const useStrictMode = !(import.meta.env.DEV && isTauriRuntime());

function AppRoot({ children }: { children: React.ReactNode }) {
  return useStrictMode ? <React.StrictMode>{children}</React.StrictMode> : <>{children}</>;
}

function clearDevPerformanceTimeline() {
  performance.clearMeasures();
  performance.clearMarks();
}

function ensureDevPerformanceTimelineCleanup() {
  if (!import.meta.env.DEV) return;

  const rootWindow = window as RootWindow;
  if (rootWindow.__scdDevPerfTimelineCleanup) return;

  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      clearDevPerformanceTimeline();
    }
  };
  const onPageHide = () => {
    clearDevPerformanceTimeline();
  };

  // Dev tooling can flood the User Timing timeline in long-running sessions.
  const intervalId = window.setInterval(() => {
    clearDevPerformanceTimeline();
  }, 15_000);

  clearDevPerformanceTimeline();
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);

  rootWindow.__scdDevPerfTimelineCleanup = {
    intervalId,
    onVisibilityChange,
    onPageHide,
  };

  import.meta.hot?.dispose(() => {
    clearDevPerformanceTimeline();
    window.clearInterval(intervalId);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', onPageHide);
    delete rootWindow.__scdDevPerfTimelineCleanup;
  });
}

function BootstrapScreen({
  title,
  label,
  error,
}: {
  title: string;
  label: string;
  error?: string;
}) {
  return (
    <div className="h-screen relative overflow-hidden bg-[rgb(8,8,10)] text-white">
      <div className="absolute inset-0">
        <div className="absolute -top-16 left-[12%] h-72 w-72 rounded-full bg-accent/[0.12] blur-[120px]" />
        <div className="absolute bottom-0 right-[10%] h-80 w-80 rounded-full bg-cyan-400/[0.08] blur-[140px]" />
      </div>
      <div className="relative flex h-full items-center justify-center p-6">
        <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-[28px] border border-white/8 bg-white/[0.04] px-7 py-8 text-center backdrop-blur-xl">
          {!error ? (
            <div className="h-10 w-10 rounded-full border-2 border-white/10 border-t-accent animate-spin" />
          ) : (
            <div className="flex h-10 w-10 items-center justify-center rounded-full border border-red-400/20 bg-red-500/12 text-sm font-semibold text-red-100">
              !
            </div>
          )}
          <div className="space-y-1">
            <div className="text-sm font-semibold tracking-tight text-white/92">{title}</div>
            <div className="text-xs text-white/45">{label}</div>
          </div>
          {error ? (
            <pre className="mt-2 max-h-56 w-full overflow-auto rounded-2xl border border-white/8 bg-black/20 p-4 text-left text-xs text-white/70">
              {error}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function getRoot(): Root | null {
  const rootEl = document.getElementById('root');
  if (!rootEl) return null;

  const rootWindow = window as RootWindow;
  const root = rootWindow.__scdRoot ?? ReactDOM.createRoot(rootEl);
  rootWindow.__scdRoot = root;
  return root;
}

function renderBootstrapScreen(root: Root, title: string, label: string, error?: string) {
  root.render(
    <AppRoot>
      <BootstrapScreen title={title} label={label} error={error} />
    </AppRoot>,
  );
}

async function registerServiceWorker(proxyPort: number) {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register(`/sw.js?port=${proxyPort}`);
    if (!navigator.serviceWorker.controller) {
      console.info('[SW] Registered, controller will attach on a later navigation.');
    }
  } catch (e) {
    console.warn('[SW] Registration failed, running without proxy SW:', e);
  }
}

async function bootstrap() {
  ensureDevPerformanceTimelineCleanup();

  const root = getRoot();
  if (!root) return;

  renderBootstrapScreen(root, 'SoundCloud Desktop', 'Starting app...');

  let staticPort = 1420;
  let proxyPort = 1420;

  try {
    let tauriRuntime = isTauriRuntime();
    if (!tauriRuntime) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      tauriRuntime = isTauriRuntime();
    }

    if (tauriRuntime) {
      renderBootstrapScreen(root, 'SoundCloud Desktop', 'Connecting desktop services...');
      await Promise.all([import('./lib/scproxy'), import('./lib/discord'), import('./lib/tray')]);
      try {
        const ports = await invoke<[number, number]>('get_server_ports');
        staticPort = ports[0];
        proxyPort = ports[1];
      } catch (e) {
        console.warn('Failed to get Tauri ports. Using defaults:', e);
      }
    } else {
      console.warn('[Bootstrap] Browser mode detected (without Tauri runtime).');
      console.warn(
        '[Bootstrap] For full app behavior run `pnpm dev:mcp` and use the Tauri window.',
      );
    }

    setServerPorts(staticPort, proxyPort);

    root.render(
      <AppRoot>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </AppRoot>,
    );

    if (tauriRuntime) {
      void registerServiceWorker(proxyPort);
    }
  } catch (error) {
    console.error('[Bootstrap] Failed to initialize app:', error);
    renderBootstrapScreen(
      root,
      'Startup failed',
      'The renderer hit an error before the main UI was ready.',
      error instanceof Error ? error.stack || error.message : String(error),
    );
  }
}

void bootstrap();
