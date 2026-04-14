import { create } from 'zustand';

export type FullscreenPanelMode = 'none' | 'artwork' | 'lyrics';
export type TransitionDirection = 'none' | 'toLyrics' | 'toArtwork';
export type FullscreenOpenAnimation = 'default' | 'fromMiniPlayer';
export type FullscreenCloseAnimation = 'none' | 'toMiniPlayer';

const FULLSCREEN_CLOSE_DURATION_MS = 460;
let fullscreenCloseTimer: ReturnType<typeof setTimeout> | null = null;

interface FullscreenPanelState {
  mode: FullscreenPanelMode;
  transitionDirection: TransitionDirection;
  openAnimation: FullscreenOpenAnimation;
  closeAnimation: FullscreenCloseAnimation;
  lyricsSplitRatio: number;
  setMode: (mode: FullscreenPanelMode) => void;
  setTransitionDirection: (dir: TransitionDirection) => void;
  setOpenAnimation: (animation: FullscreenOpenAnimation) => void;
  setLyricsSplitRatio: (ratio: number) => void;
  cancelCloseAnimation: () => void;
  beginClose: () => void;
  close: () => void;
}

interface LyricsUIState {
  open: boolean;
  toggle: () => void;
  openFromMiniPlayer: () => void;
  openPanel: () => void;
  close: () => void;
}

export interface ArtworkUIState {
  open: boolean;
  setOpen: (open: boolean) => void;
  openFromMiniPlayer: () => void;
}

export const useFullscreenPanelStore = create<FullscreenPanelState>()((set) => ({
  mode: 'none',
  transitionDirection: 'none',
  openAnimation: 'default',
  closeAnimation: 'none',
  lyricsSplitRatio: 0.45,
  setMode: (mode) => set({ mode }),
  setTransitionDirection: (dir) => set({ transitionDirection: dir }),
  setOpenAnimation: (animation) => set({ openAnimation: animation }),
  setLyricsSplitRatio: (ratio) => set({ lyricsSplitRatio: ratio }),
  cancelCloseAnimation: () => {
    if (fullscreenCloseTimer) {
      clearTimeout(fullscreenCloseTimer);
      fullscreenCloseTimer = null;
    }
    set({ closeAnimation: 'none' });
  },
  beginClose: () => {
    if (fullscreenCloseTimer) {
      clearTimeout(fullscreenCloseTimer);
      fullscreenCloseTimer = null;
    }
    useArtworkStore.setState({ open: false });
    useLyricsStore.setState({ open: false });
    set({ transitionDirection: 'none', closeAnimation: 'toMiniPlayer' });
    fullscreenCloseTimer = setTimeout(() => {
      set({
        mode: 'none',
        transitionDirection: 'none',
        openAnimation: 'default',
        closeAnimation: 'none',
      });
      fullscreenCloseTimer = null;
    }, FULLSCREEN_CLOSE_DURATION_MS);
  },
  close: () => {
    if (fullscreenCloseTimer) {
      clearTimeout(fullscreenCloseTimer);
      fullscreenCloseTimer = null;
    }
    useArtworkStore.setState({ open: false });
    useLyricsStore.setState({ open: false });
    set({
      mode: 'none',
      transitionDirection: 'none',
      openAnimation: 'default',
      closeAnimation: 'none',
    });
  },
}));

export const useLyricsStore = create<LyricsUIState>()((set) => ({
  open: false,
  toggle: () =>
    set((s) => {
      const nextOpen = !s.open;
      if (nextOpen) {
        useFullscreenPanelStore.getState().cancelCloseAnimation();
        useArtworkStore.setState({ open: false });
        useFullscreenPanelStore.getState().setOpenAnimation('default');
        useFullscreenPanelStore.getState().setTransitionDirection('toLyrics');
        useFullscreenPanelStore.getState().setMode('lyrics');
        setTimeout(() => useFullscreenPanelStore.getState().setTransitionDirection('none'), 500);
      } else {
        useFullscreenPanelStore.getState().close();
      }
      return { open: nextOpen };
    }),
  openFromMiniPlayer: () => {
    useFullscreenPanelStore.getState().cancelCloseAnimation();
    useArtworkStore.setState({ open: false });
    useFullscreenPanelStore.getState().setOpenAnimation('fromMiniPlayer');
    useFullscreenPanelStore.getState().setTransitionDirection('none');
    useFullscreenPanelStore.getState().setMode('lyrics');
    set({ open: true });
  },
  openPanel: () => {
    useFullscreenPanelStore.getState().cancelCloseAnimation();
    useArtworkStore.setState({ open: false });
    useFullscreenPanelStore.getState().setOpenAnimation('default');
    useFullscreenPanelStore.getState().setTransitionDirection('toLyrics');
    useFullscreenPanelStore.getState().setMode('lyrics');
    setTimeout(() => useFullscreenPanelStore.getState().setTransitionDirection('none'), 500);
    set({ open: true });
  },
  close: () => {
    useFullscreenPanelStore.getState().beginClose();
    set({ open: false });
  },
}));

export const useArtworkStore = create<ArtworkUIState>()((set) => ({
  open: false,
  openFromMiniPlayer: () => {
    useFullscreenPanelStore.getState().cancelCloseAnimation();
    useLyricsStore.setState({ open: false });
    useFullscreenPanelStore.getState().setOpenAnimation('fromMiniPlayer');
    useFullscreenPanelStore.getState().setTransitionDirection('none');
    useFullscreenPanelStore.getState().setMode('artwork');
    set({ open: true });
  },
  setOpen: (open) => {
    if (open) {
      useFullscreenPanelStore.getState().cancelCloseAnimation();
      useLyricsStore.setState({ open: false });
      useFullscreenPanelStore.getState().setOpenAnimation('default');
      useFullscreenPanelStore.getState().setTransitionDirection('toArtwork');
      useFullscreenPanelStore.getState().setMode('artwork');
      setTimeout(() => useFullscreenPanelStore.getState().setTransitionDirection('none'), 500);
    } else if (useFullscreenPanelStore.getState().mode === 'artwork') {
      useFullscreenPanelStore.getState().beginClose();
    }

    set({ open });
  },
}));
