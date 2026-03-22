import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { tauriStorage } from '../lib/tauri-storage';

export type ThemePreset = 'soundcloud' | 'dark' | 'neon' | 'forest' | 'crimson' | 'custom';

export interface ThemePresetDef {
  accent: string;
  bg: string;
  name: string;
  /** [accent, bg, card] for preview swatch */
  preview: [string, string, string];
}

export const THEME_PRESETS: Record<Exclude<ThemePreset, 'custom'>, ThemePresetDef> = {
  soundcloud: {
    accent: '#ff5500',
    bg: '#08080a',
    name: 'SoundCloud',
    preview: ['#ff5500', '#08080a', '#1a1a1e'],
  },
  dark: {
    accent: '#ffffff',
    bg: '#000000',
    name: 'Тьма',
    preview: ['#ffffff', '#000000', '#111111'],
  },
  neon: {
    accent: '#bf5af2',
    bg: '#08060f',
    name: 'Неон',
    preview: ['#bf5af2', '#08060f', '#18102a'],
  },
  forest: {
    accent: '#22c55e',
    bg: '#050e08',
    name: 'Лес',
    preview: ['#22c55e', '#050e08', '#0a1f10'],
  },
  crimson: {
    accent: '#ff2d55',
    bg: '#0c0507',
    name: 'Кармин',
    preview: ['#ff2d55', '#0c0507', '#1e0a10'],
  },
};

export interface SettingsState {
  accentColor: string;
  bgPrimary: string;
  themePreset: ThemePreset;
  backgroundImage: string;
  backgroundOpacity: number;
  glassBlur: number;
  language: string;
  eqEnabled: boolean;
  eqGains: number[];
  eqPreset: string;
  spotifyClientId: string;
  youtubeClientId: string;
  sidebarCollapsed: boolean;
  floatingComments: boolean;
  visualizerStyle: 'Off' | 'Bars' | 'Wave' | 'Pulse';
  visualizerPlaybar: boolean;
  visualizerFullscreen: boolean;
  visualizerThemeColor: boolean;
  visualizerWidth: number;
  visualizerHeight: number;
  visualizerScale: number;
  visualizerXOffset: number;
  visualizerYOffset: number;
  visualizerOpacity: number;
  visualizerSmoothing: number;
  visualizerMirror: boolean;
  visualizerFade: number;
  visualizerBars: number;
  targetFramerate: number;
  unlockFramerate: boolean;
  showFpsCounter: boolean;
  hardwareAcceleration: boolean;
  setAccentColor: (color: string) => void;
  setBgPrimary: (bg: string) => void;
  setThemePreset: (id: ThemePreset) => void;
  setBackgroundImage: (url: string) => void;
  setBackgroundOpacity: (opacity: number) => void;
  setGlassBlur: (blur: number) => void;
  setLanguage: (lang: string) => void;
  setEqEnabled: (enabled: boolean) => void;
  setEqGains: (gains: number[]) => void;
  setEqPreset: (preset: string) => void;
  setEqBand: (index: number, gain: number) => void;
  setSpotifyClientId: (id: string) => void;
  setYoutubeClientId: (id: string) => void;
  toggleSidebar: () => void;
  setFloatingComments: (v: boolean) => void;
  setVisualizerStyle: (style: 'Off' | 'Bars' | 'Wave' | 'Pulse') => void;
  setVisualizerPlaybar: (v: boolean) => void;
  setVisualizerFullscreen: (v: boolean) => void;
  setVisualizerThemeColor: (v: boolean) => void;
  setVisualizerWidth: (v: number) => void;
  setVisualizerHeight: (v: number) => void;
  setVisualizerScale: (v: number) => void;
  setVisualizerXOffset: (v: number) => void;
  setVisualizerYOffset: (v: number) => void;
  setVisualizerOpacity: (v: number) => void;
  setVisualizerSmoothing: (v: number) => void;
  setVisualizerMirror: (v: boolean) => void;
  setVisualizerFade: (v: number) => void;
  setVisualizerBars: (v: number) => void;
  setTargetFramerate: (fps: number) => void;
  setUnlockFramerate: (unlocked: boolean) => void;
  setShowFpsCounter: (show: boolean) => void;
  setHardwareAcceleration: (enabled: boolean) => void;
  resetTheme: () => void;
}

const DEFAULT_EQ_GAINS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

const DEFAULTS = {
  accentColor: '#ff5500',
  bgPrimary: '#08080a',
  themePreset: 'soundcloud' as ThemePreset,
  backgroundImage: '',
  backgroundOpacity: 0.15,
  glassBlur: 40,
  language: navigator.language?.split('-')[0] || 'en',
  eqEnabled: false,
  eqGains: DEFAULT_EQ_GAINS,
  eqPreset: 'flat',
  spotifyClientId: '',
  youtubeClientId: '',
  sidebarCollapsed: false,
  floatingComments: true,
  visualizerStyle: 'Wave' as const,
  visualizerPlaybar: true,
  visualizerFullscreen: false,
  visualizerThemeColor: true,
  visualizerWidth: 100,
  visualizerHeight: 56,
  visualizerScale: 100,
  visualizerXOffset: 0,
  visualizerYOffset: 0,
  visualizerOpacity: 100,
  visualizerSmoothing: 30,
  visualizerMirror: false,
  visualizerFade: 0,
  visualizerBars: 56,
  targetFramerate: 60,
  unlockFramerate: false,
  showFpsCounter: false,
  hardwareAcceleration: true,
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      ...DEFAULTS,
      setAccentColor: (accentColor) => set({ accentColor, themePreset: 'custom' }),
      setBgPrimary: (bgPrimary) => set({ bgPrimary, themePreset: 'custom' }),
      setThemePreset: (id) => {
        if (id === 'custom') {
          set({ themePreset: 'custom' });
        } else {
          const preset = THEME_PRESETS[id];
          set({ themePreset: id, accentColor: preset.accent, bgPrimary: preset.bg });
        }
      },
      setBackgroundImage: (backgroundImage) => set({ backgroundImage }),
      setBackgroundOpacity: (backgroundOpacity) => set({ backgroundOpacity }),
      setGlassBlur: (glassBlur) => set({ glassBlur }),
      setLanguage: (language) => set({ language }),
      setEqEnabled: (eqEnabled) => {
        set({ eqEnabled });
        invoke('audio_set_eq', { enabled: eqEnabled, gains: get().eqGains }).catch(console.error);
      },
      setEqGains: (eqGains) => {
        set({ eqGains, eqPreset: 'custom' });
        invoke('audio_set_eq', { enabled: get().eqEnabled, gains: eqGains }).catch(console.error);
      },
      setEqPreset: (eqPreset) => set({ eqPreset }),
      setEqBand: (index, gain) => {
        set((s) => {
          const eqGains = [...s.eqGains];
          eqGains[index] = gain;
          invoke('audio_set_eq', { enabled: s.eqEnabled, gains: eqGains }).catch(console.error);
          return { eqGains, eqPreset: 'custom' };
        });
      },
      setSpotifyClientId: (spotifyClientId) => set({ spotifyClientId }),
      setYoutubeClientId: (youtubeClientId) => set({ youtubeClientId }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setFloatingComments: (floatingComments) => set({ floatingComments }),
      setVisualizerStyle: (visualizerStyle) => set({ visualizerStyle }),
      setVisualizerPlaybar: (visualizerPlaybar) => set({ visualizerPlaybar }),
      setVisualizerFullscreen: (visualizerFullscreen) => set({ visualizerFullscreen }),
      setVisualizerThemeColor: (visualizerThemeColor) => set({ visualizerThemeColor }),
      setVisualizerWidth: (visualizerWidth) => set({ visualizerWidth }),
      setVisualizerHeight: (visualizerHeight) => set({ visualizerHeight }),
      setVisualizerScale: (visualizerScale) => set({ visualizerScale }),
      setVisualizerXOffset: (visualizerXOffset) => set({ visualizerXOffset }),
      setVisualizerYOffset: (visualizerYOffset) => set({ visualizerYOffset }),
      setVisualizerOpacity: (visualizerOpacity) => set({ visualizerOpacity }),
      setVisualizerSmoothing: (visualizerSmoothing) => set({ visualizerSmoothing }),
      setVisualizerMirror: (visualizerMirror) => set({ visualizerMirror }),
      setVisualizerFade: (visualizerFade) => set({ visualizerFade }),
      setVisualizerBars: (visualizerBars) => set({ visualizerBars }),
      setTargetFramerate: (targetFramerate) => {
        set({ targetFramerate });
        invoke('save_framerate_config', { target: targetFramerate, unlocked: get().unlockFramerate }).catch(console.error);
      },
      setUnlockFramerate: (unlockFramerate) => {
        set({ unlockFramerate });
        invoke('save_framerate_config', { target: get().targetFramerate, unlocked: unlockFramerate }).catch(console.error);
      },
      setShowFpsCounter: (showFpsCounter) => set({ showFpsCounter }),
      setHardwareAcceleration: (hardwareAcceleration) => set({ hardwareAcceleration }),
      resetTheme: () => set(DEFAULTS),
    }),
    {
      name: 'sc-settings',
      storage: createJSONStorage(() => tauriStorage),
      version: 4,
      partialize: (s) => ({
        accentColor: s.accentColor,
        bgPrimary: s.bgPrimary,
        themePreset: s.themePreset,
        backgroundImage: s.backgroundImage,
        backgroundOpacity: s.backgroundOpacity,
        glassBlur: s.glassBlur,
        language: s.language,
        eqEnabled: s.eqEnabled,
        eqGains: s.eqGains,
        eqPreset: s.eqPreset,
        spotifyClientId: s.spotifyClientId,
        youtubeClientId: s.youtubeClientId,
        sidebarCollapsed: s.sidebarCollapsed,
        floatingComments: s.floatingComments,
        targetFramerate: s.targetFramerate,
        unlockFramerate: s.unlockFramerate,
        showFpsCounter: s.showFpsCounter,
        hardwareAcceleration: s.hardwareAcceleration,
      }),
    },
  ),
);
