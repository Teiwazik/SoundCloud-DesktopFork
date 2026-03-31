import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { useShallow } from 'zustand/shallow';
import { AppShell } from './components/layout/AppShell';
import { ThemeProvider } from './components/ThemeProvider';
import { UpdateChecker } from './components/UpdateChecker';
import { ApiError, setSessionExpiredHandler, setUnauthorizedHandler } from './lib/api';
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

export default function App() {
  const { isAuthenticated, sessionId, fetchUser, logout } = useAuthStore(
    useShallow((s) => ({
      isAuthenticated: s.isAuthenticated,
      sessionId: s.sessionId,
      fetchUser: s.fetchUser,
      logout: s.logout,
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
    setUnauthorizedHandler(() => {
      useAppStatusStore.getState().setBackendReachable(false);
      logout();
    });

    setSessionExpiredHandler(() => {
      useAppStatusStore.getState().resetConnectivity();
      logout();
    });

    return () => {
      setUnauthorizedHandler(null);
      setSessionExpiredHandler(null);
    };
  }, [logout]);

  useEffect(() => {
    if (appMode !== 'online') {
      setChecking(false);
      return;
    }

    if (sessionId) {
      setChecking(true);
      fetchUser()
        .catch((error) => {
          if (error instanceof ApiError && error.status === 401) {
            useAppStatusStore.getState().setBackendReachable(false);
            return;
          }

          console.warn('[Auth] Keeping local session after /me bootstrap failure:', error);
          useAuthStore.setState({ isAuthenticated: true });
        })
        .finally(() => setChecking(false));
    } else {
      setChecking(false);
    }
  }, [appMode, fetchUser, logout, sessionId]);

  const showOfflineShell = appMode !== 'online';

  if (checking && !showOfflineShell) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

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
          <Login />
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
