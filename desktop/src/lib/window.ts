import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauriRuntime } from './runtime';

export async function toggleWindowFullscreen() {
  if (isTauriRuntime()) {
    const currentWindow = getCurrentWindow();
    const isFullscreen = await currentWindow.isFullscreen();
    await currentWindow.setFullscreen(!isFullscreen);
    return;
  }

  if (typeof document === 'undefined') return;

  if (document.fullscreenElement) {
    await document.exitFullscreen();
    return;
  }

  await document.documentElement.requestFullscreen();
}
