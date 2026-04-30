import { invoke as invokeTauri } from '@tauri-apps/api/core';
import { Component, type ErrorInfo, type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { useShallow } from 'zustand/shallow';
import { AppShell } from './components/layout/AppShell';
import { ThemeProvider } from './components/ThemeProvider';
import { UpdateChecker } from './components/UpdateChecker';
import { ApiError, setSessionExpiredHandler, setUnauthorizedHandler } from './lib/api';
import { applyAppFont } from './lib/app-font';
import { hasAuthHydrated } from './lib/auth-hydration';
import { Home } from './pages/Home';
import { Library } from './pages/Library';
import { Login } from './pages/Login';
import { OfflinePage } from './pages/OfflinePage';
import { PlaylistPage } from './pages/PlaylistPage';
import { Search } from './pages/Search';
import { Settings } from './pages/Settings';
import { TrackPage } from './pages/TrackPage';
import { UserPage } from './pages/UserPage';
import { useAppStatusStore } from './stores/app-status';
import { useAuthStore } from './stores/auth';
import { useSettingsStore } from './stores/settings';

const AUTH_BOOTSTRAP_TIMEOUT_MS = 12000;

type AppErrorBoundaryState = {
  error: Error | null;
};

class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[App] Render crash:', error, errorInfo);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="h-screen relative overflow-hidden bg-[rgb(8,8,10)] text-white">
          <div className="absolute inset-0">
            <div className="absolute top-[12%] left-[10%] h-72 w-72 rounded-full bg-red-500/[0.12] blur-[120px]" />
            <div className="absolute bottom-[8%] right-[10%] h-80 w-80 rounded-full bg-accent/[0.08] blur-[140px]" />
          </div>
          <div className="relative flex h-full items-center justify-center p-6">
            <div className="w-full max-w-lg rounded-[28px] border border-white/8 bg-white/[0.04] px-7 py-8 backdrop-blur-xl">
              <div className="text-lg font-semibold tracking-tight text-white/92">Renderer crashed</div>
              <div className="mt-2 text-sm text-white/55">
                The app hit a React error before the main UI finished rendering.
              </div>
              <pre className="mt-4 overflow-auto rounded-2xl border border-white/8 bg-black/20 p-4 text-xs text-white/70">
                {this.state.error.stack || this.state.error.message}
              </pre>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

function AppInner() {
  const { t } = useTranslation();
  const { isAuthenticated, sessionId, reloginRequestId, fetchUser, beginRelogin } = useAuthStore(
    useShallow((s) => ({
      isAuthenticated: s.isAuthenticated,
      sessionId: s.sessionId,
      reloginRequestId: s.reloginRequestId,
      fetchUser: s.fetchUser,
      beginRelogin: s.beginRelogin,
    })),
  );
  const appMode = useAppStatusStore((s) =>
    s.soundcloudBlocked
      ? 'blocked'
      : !s.navigatorOnline || !s.backendReachable
        ? 'offline'
        : 'online',
  );
  const [checking, setChecking] = useState(true);
  const [authHydrated, setAuthHydrated] = useState(() => useAuthStore.persist.hasHydrated());

  // Re-apply persisted app icon choice on each app start. Tauri uses the
  // built-in icon from tauri.conf.json at boot — if the user previously
  // picked something else, we override here as soon as React mounts.
  useEffect(() => {
    const s = useSettingsStore.getState();
    if (s.appIcon === 'custom' && s.customAppIconPath) {
      void invokeTauri('set_custom_app_icon', { path: s.customAppIconPath }).catch(() => {
        // File missing/unreadable — fall back to default so the user isn't
        // stuck with a broken titlebar icon.
        void invokeTauri('set_app_icon', { variant: 'default' }).catch(() => {});
      });
    } else {
      void invokeTauri('set_app_icon', { variant: s.appIcon }).catch(() => {});
    }
  }, []);

  // Re-apply the chosen font on every relevant settings change. Subscribing
  // to a slice (not the whole store) keeps this effect quiet when unrelated
  // settings update.
  const fontMode = useSettingsStore((s) => s.appFontMode);
  const fontSystemFamily = useSettingsStore((s) => s.appFontSystemFamily);
  const fontCustomPath = useSettingsStore((s) => s.appFontCustomPath);
  const fontCustomFamily = useSettingsStore((s) => s.appFontCustomFamily);
  const fontSize = useSettingsStore((s) => s.appFontSize);
  const uiScale = useSettingsStore((s) => s.appUiScale);
  useEffect(() => {
    void applyAppFont({
      mode: fontMode,
      systemFamily: fontSystemFamily,
      customPath: fontCustomPath,
      customFamily: fontCustomFamily,
      textSize: fontSize,
      uiScale,
    });
  }, [fontMode, fontSystemFamily, fontCustomPath, fontCustomFamily, fontSize, uiScale]);

  useEffect(() => {
    const syncOnline = () => {
      const online = navigator.onLine;
      const appStatus = useAppStatusStore.getState();
      appStatus.setNavigatorOnline(online);
      if (online) {
        appStatus.setBackendReachable(true);
      }
    };

    syncOnline();
    window.addEventListener('online', syncOnline);
    window.addEventListener('offline', syncOnline);

    return () => {
      window.removeEventListener('online', syncOnline);
      window.removeEventListener('offline', syncOnline);
    };
  }, []);

  useEffect(() => {
    if (useAuthStore.persist.hasHydrated() || hasAuthHydrated()) {
      setAuthHydrated(true);
      return;
    }

    const unsubscribe = useAuthStore.persist.onFinishHydration(() => {
      setAuthHydrated(true);
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      useAuthStore.getState().beginRelogin();
    });

    setSessionExpiredHandler(() => {
      useAuthStore.getState().beginRelogin();
    });

    return () => {
      setUnauthorizedHandler(null);
      setSessionExpiredHandler(null);
    };
  }, [beginRelogin]);

  useEffect(() => {
    if (!authHydrated) {
      setChecking(true);
      return;
    }

    if (appMode !== 'online') {
      setChecking(false);
      return;
    }

    if (sessionId) {
      setChecking(true);
      fetchUser({ timeoutMs: AUTH_BOOTSTRAP_TIMEOUT_MS })
        .catch((error) => {
          if (error instanceof ApiError && error.status === 401) {
            console.warn('[Auth] Stored session was rejected, reopening login');
            useAppStatusStore.getState().setBackendReachable(true);
            useAuthStore.getState().beginRelogin();
            return;
          }

          if (error instanceof Error && error.name === 'AbortError') {
            console.warn('[Auth] /me bootstrap timed out, keeping local session');
            useAppStatusStore.getState().setBackendReachable(true);
            useAuthStore.setState({ isAuthenticated: true });
            return;
          }

          console.warn('[Auth] Failed to restore /me, keeping local session:', error);
          useAppStatusStore.getState().setBackendReachable(true);
          useAuthStore.setState({ isAuthenticated: true });
        })
        .finally(() => setChecking(false));
    } else {
      setChecking(false);
    }
  }, [appMode, authHydrated, beginRelogin, fetchUser, sessionId]);

  const showOfflineShell = appMode !== 'online';
  const isBooting = (!authHydrated || checking) && !showOfflineShell;

  return (
    <ThemeProvider>
      <BrowserRouter>
        <Toaster
          theme="dark"
          position="top-right"
          toastOptions={{
            style: {
              background: 'rgba(30, 30, 34, 0.9)',
              backdropFilter: 'blur(20px)',
              border: '1px solid rgba(255,255,255,0.08)',
              color: 'rgba(255,255,255,0.85)',
              fontSize: '13px',
            },
          }}
        />
        {isBooting && (
          <div
            className="fixed top-3 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-2.5 px-5 py-2.5 rounded-full border border-white/[0.08] bg-white/[0.06] backdrop-blur-[20px] shadow-[0_8px_32px_rgba(0,0,0,0.4)] animate-fade-in whitespace-nowrap"
          >
            <span className="text-[12px] font-medium text-white/70">
              {sessionId ? t('auth.restoringSession') : t('auth.startingApp')}
            </span>
            <div className="h-4 w-4 rounded-full border-2 border-white/10 border-t-accent animate-spin" />
          </div>
        )}
        {appMode === 'online' && isAuthenticated && <UpdateChecker />}

        {showOfflineShell ? (
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<Navigate to="/offline" replace />} />
              <Route path="offline" element={<OfflinePage />} />
              <Route path="settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/offline" replace />} />
            </Route>
          </Routes>
        ) : !isAuthenticated ? (
          <Login autoStartRequestId={reloginRequestId} />
        ) : (
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<Home />} />
              <Route path="search" element={<Search />} />
              <Route path="library" element={<Library />} />
              <Route path="offline" element={<OfflinePage />} />
              <Route path="track/:urn" element={<TrackPage />} />
              <Route path="playlist/:urn" element={<PlaylistPage />} />
              <Route path="user/:urn" element={<UserPage />} />
              <Route path="settings" element={<Settings />} />
            </Route>
          </Routes>
        )}
      </BrowserRouter>
    </ThemeProvider>
  );
}

export default function App() {
  return (
    <AppErrorBoundary>
      <AppInner />
    </AppErrorBoundary>
  );
}
