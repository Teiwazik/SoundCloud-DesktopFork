import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { tauriStorage } from '../lib/tauri-storage';

interface DislikesState {
  dislikedTrackUrns: string[];
  toggleDislike: (urn: string) => void;
  isDisliked: (urn: string) => boolean;
}

export const useDislikesStore = create<DislikesState>()(
  persist(
    (set, get) => ({
      dislikedTrackUrns: [],
      toggleDislike: (urn) => {
        const { dislikedTrackUrns } = get();
        if (dislikedTrackUrns.includes(urn)) {
          set({ dislikedTrackUrns: dislikedTrackUrns.filter((u) => u !== urn) });
        } else {
          set({ dislikedTrackUrns: [...dislikedTrackUrns, urn] });
        }
      },
      isDisliked: (urn) => get().dislikedTrackUrns.includes(urn),
    }),
    {
      name: 'sc-dislikes',
      storage: createJSONStorage(() => tauriStorage),
    }
  )
);
