import { create } from 'zustand';

interface LyricsUIState {
  open: boolean;
  toggle: () => void;
  openPanel: () => void;
  close: () => void;
}

export const useLyricsStore = create<LyricsUIState>()((set) => ({
  open: false,
  toggle: () => set((s) => ({ open: !s.open })),
  openPanel: () => set({ open: true }),
  close: () => set({ open: false }),
}));

export interface ArtworkUIState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useArtworkStore = create<ArtworkUIState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
