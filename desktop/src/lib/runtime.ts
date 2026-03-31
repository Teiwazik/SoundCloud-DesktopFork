import { isTauri } from '@tauri-apps/api/core';

type RuntimeWindow = Window & {
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: unknown;
};

export function isTauriRuntime(): boolean {
  if (isTauri()) return true;
  if (typeof window === 'undefined') return false;
  const runtimeWindow = window as RuntimeWindow;
  return Boolean(runtimeWindow.__TAURI__ || runtimeWindow.__TAURI_INTERNALS__);
}
