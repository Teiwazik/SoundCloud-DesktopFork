import { create } from 'zustand';

export type AppMode = 'online' | 'offline' | 'blocked';

interface AppStatusState {
  navigatorOnline: boolean;
  backendReachable: boolean;
  soundcloudBlocked: boolean;
  setNavigatorOnline: (online: boolean) => void;
  setBackendReachable: (reachable: boolean) => void;
  setSoundcloudBlocked: (blocked: boolean) => void;
  resetConnectivity: () => void;
}

export const useAppStatusStore = create<AppStatusState>((set) => ({
  navigatorOnline: typeof navigator === 'undefined' ? true : navigator.onLine,
  backendReachable: true,
  soundcloudBlocked: false,
  setNavigatorOnline: (online) => set({ navigatorOnline: online }),
  setBackendReachable: (backendReachable) => set({ backendReachable }),
  setSoundcloudBlocked: (soundcloudBlocked) => set({ soundcloudBlocked }),
  resetConnectivity: () =>
    set({
      navigatorOnline: typeof navigator === 'undefined' ? true : navigator.onLine,
      backendReachable: true,
      soundcloudBlocked: false,
    }),
}));

export function getAppMode(): AppMode {
  const { navigatorOnline, backendReachable, soundcloudBlocked } = useAppStatusStore.getState();
  if (soundcloudBlocked) return 'blocked';
  if (!navigatorOnline || !backendReachable) return 'offline';
  return 'online';
}

export function isOfflineMode() {
  return getAppMode() !== 'online';
}
