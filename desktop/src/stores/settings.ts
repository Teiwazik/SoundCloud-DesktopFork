import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { tauriStorage } from '../lib/tauri-storage';

const ENCODED_QDRANT_URL =
  'aHR0cHM6Ly9hZDkzOTEzOS00ODE5LTRkM2EtYjJhMS0xMTQ3YTAzZjU5YWMuc2EtZWFzdC0xLTAuYXdzLmNsb3VkLnFkcmFudC5pby8=';
const ENCODED_QDRANT_KEY =
  'ZXlKaGJHY2lPaUpJVXpJMU5pSXNJblI1Y0NJNklrcFhWQ0o5LmV5SmhZMk5sYzNNaU9pSnRJbjAuZ3ZTVlZEbFNEMms1OWxDb2ktSms2bFQtUUVPXzRYbXBVQmJ6eDNEdDRTOA==';
const ENCODED_QDRANT_COLLECTION = 'c3dfMTI=';

const decodeBase64 = (str: string): string => {
  return atob(str);
};

const STORAGE_KEY_PREFIX = 'enc:qdrant:v1:';
const STORAGE_KEY_SEED = 'scd_qdrant_seed_v1';

const encodeQdrantKeyForStorage = (value: string): string => {
  const normalized = value.trim();
  if (!normalized) return '';
  const transformed = Array.from(normalized, (char, index) => {
    const seed = STORAGE_KEY_SEED.charCodeAt(index % STORAGE_KEY_SEED.length);
    return String.fromCharCode(char.charCodeAt(0) ^ seed);
  }).join('');
  return `${STORAGE_KEY_PREFIX}${btoa(transformed)}`;
};

const decodeQdrantKeyFromStorage = (value: string): string => {
  if (!value) return '';
  if (!value.startsWith(STORAGE_KEY_PREFIX)) return value;

  try {
    const encoded = value.slice(STORAGE_KEY_PREFIX.length);
    const transformed = atob(encoded);
    return Array.from(transformed, (char, index) => {
      const seed = STORAGE_KEY_SEED.charCodeAt(index % STORAGE_KEY_SEED.length);
      return String.fromCharCode(char.charCodeAt(0) ^ seed);
    }).join('');
  } catch {
    return '';
  }
};

const PREDEFINED_QDRANT_URL = decodeBase64(ENCODED_QDRANT_URL);
const PREDEFINED_QDRANT_KEY = decodeBase64(ENCODED_QDRANT_KEY);
const PREDEFINED_QDRANT_COLLECTION = decodeBase64(ENCODED_QDRANT_COLLECTION);

const normalizeQdrantUrl = (value: string): string =>
  value.trim().replace('aws.courd.qdrant.io', 'aws.cloud.qdrant.io');
const normalizePreferredLanguages = (value: unknown): string[] => {
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string' && value.trim() && value !== 'all'
      ? [value]
      : [];

  const deduped = new Set<string>();
  for (const entry of source) {
    if (typeof entry !== 'string') continue;
    const normalized = entry.trim().toLowerCase();
    if (!normalized || normalized === 'all' || deduped.has(normalized)) continue;
    deduped.add(normalized);
  }

  return Array.from(deduped);
};

export type ThemePreset = 'soundcloud' | 'dark' | 'neon' | 'forest' | 'crimson' | 'custom';
export type ThemeGradientType = 'linear' | 'radial';
export type ThemeGradientAnimation = 'flow' | 'pulse' | 'breathe';
export type DiscordRpcMode = 'text' | 'track' | 'artist' | 'activity';
export type DiscordRpcButtonMode = 'soundcloud' | 'app' | 'both';
export type ApiMode = 'auto' | 'custom';

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
  themeGradientEnabled: boolean;
  themeGradientFollowArtwork: boolean;
  themeGradientType: ThemeGradientType;
  themeGradientColorA: string;
  themeGradientColorB: string;
  themeGradientColorC: string;
  themeGradientAngle: number;
  themeGradientAnimated: boolean;
  themeGradientAnimation: ThemeGradientAnimation;
  themeGradientSpeed: number;
  themeGlowEnabled: boolean;
  themeGlowIntensity: number;
  themeGlowOpacity: number;
  backgroundImage: string;
  backgroundOpacity: number;
  glassBlur: number;
  language: string;
  eqEnabled: boolean;
  eqGains: number[];
  eqPreset: string;
  normalizeVolume: boolean;
  highQualityStreaming: boolean;
  spotifyClientId: string;
  youtubeClientId: string;
  youtubeClientSecret: string;
  soundcloudClientId: string;
  soundcloudClientSecret: string;
  apiMode: ApiMode;
  customApiKey: string;
  sidebarCollapsed: boolean;
  crossfadeEnabled: boolean;
  crossfadeDuration: number;
  floatingComments: boolean;
  discordRpc: boolean;
  discordRpcMode: DiscordRpcMode;
  discordRpcShowButton: boolean;
  discordRpcButtonMode: DiscordRpcButtonMode;
  qdrantEnabled: boolean;
  qdrantUrl: string;
  qdrantKey: string;
  qdrantCollection: string;
  regionalTrendSeed: boolean;
  regionalTrendRegions: string;
  llmRerankEnabled: boolean;
  llmEndpoint: string;
  llmModel: string;
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
  lowPerformanceMode: boolean;
  targetFramerate: number;
  unlockFramerate: boolean;
  showFpsCounter: boolean;
  hardwareAcceleration: boolean;
  classicPlaybar: boolean;
  experimentalRuAudioTextWarmup: boolean;
  soundwavePresetKey: string;
  languageFilterEnabled: boolean;
  preferredLanguages: string[];
  soundwaveGenreStrict: boolean;
  soundwaveSelectedGenres: string[];
  soundwaveHideLiked: boolean;
  setAccentColor: (color: string) => void;
  setBgPrimary: (bg: string) => void;
  setThemePreset: (id: ThemePreset) => void;
  setThemeGradientEnabled: (enabled: boolean) => void;
  setThemeGradientFollowArtwork: (enabled: boolean) => void;
  setThemeGradientType: (type: ThemeGradientType) => void;
  setThemeGradientColorA: (color: string) => void;
  setThemeGradientColorB: (color: string) => void;
  setThemeGradientColorC: (color: string) => void;
  setThemeGradientAngle: (angle: number) => void;
  setThemeGradientAnimated: (enabled: boolean) => void;
  setThemeGradientAnimation: (animation: ThemeGradientAnimation) => void;
  setThemeGradientSpeed: (speed: number) => void;
  setThemeGlowEnabled: (enabled: boolean) => void;
  setThemeGlowIntensity: (intensity: number) => void;
  setThemeGlowOpacity: (opacity: number) => void;
  setBackgroundImage: (url: string) => void;
  setBackgroundOpacity: (opacity: number) => void;
  setGlassBlur: (blur: number) => void;
  setLanguage: (lang: string) => void;
  setEqEnabled: (enabled: boolean) => void;
  setEqGains: (gains: number[]) => void;
  setEqPreset: (preset: string) => void;
  setEqBand: (index: number, gain: number) => void;
  setNormalizeVolume: (enabled: boolean) => void;
  setHighQualityStreaming: (enabled: boolean) => void;
  setSpotifyClientId: (id: string) => void;
  setYoutubeClientId: (id: string) => void;
  setYoutubeClientSecret: (secret: string) => void;
  setSoundcloudClientId: (id: string) => void;
  setSoundcloudClientSecret: (secret: string) => void;
  setApiMode: (mode: ApiMode) => void;
  setCustomApiKey: (key: string) => void;
  setCrossfadeEnabled: (v: boolean) => void;
  setCrossfadeDuration: (v: number) => void;
  toggleSidebar: () => void;
  setFloatingComments: (v: boolean) => void;
  setDiscordRpc: (v: boolean) => void;
  setDiscordRpcMode: (mode: DiscordRpcMode) => void;
  setDiscordRpcShowButton: (show: boolean) => void;
  setDiscordRpcButtonMode: (mode: DiscordRpcButtonMode) => void;
  setQdrantEnabled: (v: boolean) => void;
  setQdrantUrl: (v: string) => void;
  setQdrantKey: (v: string) => void;
  setQdrantCollection: (v: string) => void;
  setRegionalTrendSeed: (v: boolean) => void;
  setRegionalTrendRegions: (v: string) => void;
  setLlmRerankEnabled: (v: boolean) => void;
  setLlmEndpoint: (v: string) => void;
  setLlmModel: (v: string) => void;
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
  setLowPerformanceMode: (v: boolean) => void;
  setTargetFramerate: (fps: number) => void;
  setUnlockFramerate: (unlocked: boolean) => void;
  setShowFpsCounter: (show: boolean) => void;
  setHardwareAcceleration: (enabled: boolean) => void;
  setClassicPlaybar: (v: boolean) => void;
  setExperimentalRuAudioTextWarmup: (v: boolean) => void;
  setSoundwavePresetKey: (key: string) => void;
  setLanguageFilterEnabled: (v: boolean) => void;
  setPreferredLanguages: (langs: string[]) => void;
  togglePreferredLanguage: (lang: string) => void;
  setPreferredLanguage: (lang: string) => void;
  setSoundwaveGenreStrict: (v: boolean) => void;
  setSoundwaveSelectedGenres: (genres: string[]) => void;
  setSoundwaveHideLiked: (v: boolean) => void;
  resetTheme: () => void;
}

const DEFAULT_EQ_GAINS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

const ENV_QDRANT_URL = normalizeQdrantUrl(
  import.meta.env.VITE_QDRANT_URL?.trim() || PREDEFINED_QDRANT_URL,
);
const ENV_QDRANT_KEY = import.meta.env.VITE_QDRANT_API_KEY?.trim() || PREDEFINED_QDRANT_KEY;
const ENV_QDRANT_COLLECTION =
  import.meta.env.VITE_QDRANT_COLLECTION?.trim() || PREDEFINED_QDRANT_COLLECTION;
const ENV_QDRANT_ENABLED_RAW = import.meta.env.VITE_QDRANT_ENABLED;
const ENV_QDRANT_ENABLED = ENV_QDRANT_ENABLED_RAW
  ? ['1', 'true', 'yes', 'on'].includes(ENV_QDRANT_ENABLED_RAW.toLowerCase())
  : Boolean(ENV_QDRANT_URL);
const ENV_REGIONAL_TREND_SEED =
  (import.meta.env.VITE_SW_REGIONAL_TRENDS || '').toLowerCase() === 'true';
const ENV_REGIONAL_TREND_REGIONS =
  import.meta.env.VITE_SW_REGIONAL_TREND_REGIONS?.trim() || 'us,gb,de,fr,br,jp,kr,mx';
const ENV_LLM_RERANK = (import.meta.env.VITE_SW_LLM_RERANK || '').toLowerCase() === 'true';
const ENV_LLM_ENDPOINT = import.meta.env.VITE_SW_LLM_ENDPOINT?.trim() || 'http://127.0.0.1:11434';
const ENV_LLM_MODEL = import.meta.env.VITE_SW_LLM_MODEL?.trim() || 'qwen2.5:14b';

export const resolveQdrantApiKey = (rawKey: string): string => {
  const normalized = rawKey.trim();
  return normalized || ENV_QDRANT_KEY;
};

export const isDefaultQdrantKeyInUse = (rawKey: string): boolean => rawKey.trim().length === 0;

const DEFAULTS = {
  accentColor: '#ff5500',
  bgPrimary: '#08080a',
  themePreset: 'soundcloud' as ThemePreset,
  themeGradientEnabled: true,
  themeGradientFollowArtwork: false,
  themeGradientType: 'linear' as ThemeGradientType,
  themeGradientColorA: '#0b1220',
  themeGradientColorB: '#1a1b3a',
  themeGradientColorC: '#402014',
  themeGradientAngle: 135,
  themeGradientAnimated: true,
  themeGradientAnimation: 'flow' as ThemeGradientAnimation,
  themeGradientSpeed: 16,
  themeGlowEnabled: true,
  themeGlowIntensity: 72,
  themeGlowOpacity: 58,
  backgroundImage: '',
  backgroundOpacity: 0.15,
  glassBlur: 40,
  language: navigator.language?.split('-')[0] || 'en',
  eqEnabled: false,
  eqGains: DEFAULT_EQ_GAINS,
  eqPreset: 'flat',
  normalizeVolume: true,
  highQualityStreaming: false,
  spotifyClientId: '',
  youtubeClientId: '',
  youtubeClientSecret: '',
  soundcloudClientId: '',
  soundcloudClientSecret: '',
  apiMode: 'auto' as ApiMode,
  customApiKey: '',
  crossfadeEnabled: false,
  crossfadeDuration: 6,
  sidebarCollapsed: false,
  floatingComments: true,
  discordRpc: true,
  discordRpcMode: 'text' as DiscordRpcMode,
  discordRpcShowButton: true,
  discordRpcButtonMode: 'soundcloud' as DiscordRpcButtonMode,
  qdrantEnabled: ENV_QDRANT_ENABLED,
  qdrantUrl: ENV_QDRANT_URL,
  qdrantKey: '',
  qdrantCollection: ENV_QDRANT_COLLECTION,
  regionalTrendSeed: ENV_REGIONAL_TREND_SEED,
  regionalTrendRegions: ENV_REGIONAL_TREND_REGIONS,
  llmRerankEnabled: ENV_LLM_RERANK,
  llmEndpoint: ENV_LLM_ENDPOINT,
  llmModel: ENV_LLM_MODEL,
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
  visualizerSmoothing: 60,
  visualizerMirror: false,
  visualizerFade: 0,
  visualizerBars: 32,
  lowPerformanceMode: false,
  targetFramerate: 60,
  unlockFramerate: false,
  showFpsCounter: false,
  hardwareAcceleration: true,
  classicPlaybar: false,
  experimentalRuAudioTextWarmup: false,
  soundwavePresetKey: 'work',
  languageFilterEnabled: false,
  preferredLanguages: [],
  soundwaveGenreStrict: true,
  soundwaveSelectedGenres: [],
  soundwaveHideLiked: false,
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
      setThemeGradientEnabled: (themeGradientEnabled) =>
        set({ themeGradientEnabled, themePreset: 'custom' }),
      setThemeGradientFollowArtwork: (themeGradientFollowArtwork) =>
        set({ themeGradientFollowArtwork, themePreset: 'custom' }),
      setThemeGradientType: (themeGradientType) =>
        set({ themeGradientType, themePreset: 'custom' }),
      setThemeGradientColorA: (themeGradientColorA) =>
        set({ themeGradientColorA, themePreset: 'custom' }),
      setThemeGradientColorB: (themeGradientColorB) =>
        set({ themeGradientColorB, themePreset: 'custom' }),
      setThemeGradientColorC: (themeGradientColorC) =>
        set({ themeGradientColorC, themePreset: 'custom' }),
      setThemeGradientAngle: (themeGradientAngle) =>
        set({ themeGradientAngle, themePreset: 'custom' }),
      setThemeGradientAnimated: (themeGradientAnimated) =>
        set({ themeGradientAnimated, themePreset: 'custom' }),
      setThemeGradientAnimation: (themeGradientAnimation) =>
        set({ themeGradientAnimation, themePreset: 'custom' }),
      setThemeGradientSpeed: (themeGradientSpeed) =>
        set({ themeGradientSpeed, themePreset: 'custom' }),
      setThemeGlowEnabled: (themeGlowEnabled) => set({ themeGlowEnabled, themePreset: 'custom' }),
      setThemeGlowIntensity: (themeGlowIntensity) =>
        set({ themeGlowIntensity, themePreset: 'custom' }),
      setThemeGlowOpacity: (themeGlowOpacity) => set({ themeGlowOpacity, themePreset: 'custom' }),
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
      setNormalizeVolume: (normalizeVolume) => {
        set({ normalizeVolume });
        invoke('audio_set_normalization', { enabled: normalizeVolume }).catch(console.error);
      },
      setHighQualityStreaming: (highQualityStreaming) => set({ highQualityStreaming }),
      setSpotifyClientId: (spotifyClientId) => set({ spotifyClientId }),
      setYoutubeClientId: (youtubeClientId) => set({ youtubeClientId }),
      setYoutubeClientSecret: (youtubeClientSecret) => set({ youtubeClientSecret }),
      setSoundcloudClientId: (soundcloudClientId) => set({ soundcloudClientId }),
      setSoundcloudClientSecret: (soundcloudClientSecret) => set({ soundcloudClientSecret }),
      setApiMode: (apiMode) => set({ apiMode }),
      setCustomApiKey: (customApiKey) => set({ customApiKey }),
      setCrossfadeEnabled: (crossfadeEnabled) => set({ crossfadeEnabled }),
      setCrossfadeDuration: (crossfadeDuration) => set({ crossfadeDuration }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setFloatingComments: (floatingComments) => set({ floatingComments }),
      setDiscordRpc: (discordRpc) => set({ discordRpc }),
      setDiscordRpcMode: (discordRpcMode) => set({ discordRpcMode }),
      setDiscordRpcShowButton: (discordRpcShowButton) => set({ discordRpcShowButton }),
      setDiscordRpcButtonMode: (discordRpcButtonMode) => set({ discordRpcButtonMode }),
      setQdrantEnabled: (qdrantEnabled) => set({ qdrantEnabled }),
      setQdrantUrl: (qdrantUrl) => set({ qdrantUrl: normalizeQdrantUrl(qdrantUrl) }),
      setQdrantKey: (qdrantKey) => set({ qdrantKey: qdrantKey.trim() }),
      setQdrantCollection: (qdrantCollection) => set({ qdrantCollection }),
      setRegionalTrendSeed: (regionalTrendSeed) => set({ regionalTrendSeed }),
      setRegionalTrendRegions: (regionalTrendRegions) => set({ regionalTrendRegions }),
      setLlmRerankEnabled: (llmRerankEnabled) => set({ llmRerankEnabled }),
      setLlmEndpoint: (llmEndpoint) => set({ llmEndpoint }),
      setLlmModel: (llmModel) => set({ llmModel }),
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
      setLowPerformanceMode: (lowPerformanceMode) => {
        set((state) => ({
          lowPerformanceMode,
          ...(lowPerformanceMode
            ? {
                floatingComments: false,
                visualizerStyle: 'Off' as const,
                visualizerFullscreen: false,
                visualizerPlaybar: false,
                targetFramerate: Math.min(state.targetFramerate, 30),
                unlockFramerate: false,
                showFpsCounter: false,
              }
            : {}),
        }));

        if (lowPerformanceMode) {
          invoke('save_framerate_config', {
            target: Math.min(get().targetFramerate, 30),
            unlocked: false,
          }).catch(console.error);
        }
      },
      setTargetFramerate: (targetFramerate) => {
        set({ targetFramerate });
        invoke('save_framerate_config', {
          target: targetFramerate,
          unlocked: get().unlockFramerate,
        }).catch(console.error);
      },
      setUnlockFramerate: (unlockFramerate) => {
        set({ unlockFramerate });
        invoke('save_framerate_config', {
          target: get().targetFramerate,
          unlocked: unlockFramerate,
        }).catch(console.error);
      },
      setShowFpsCounter: (showFpsCounter) => set({ showFpsCounter }),
      setHardwareAcceleration: (hardwareAcceleration) => set({ hardwareAcceleration }),
      setClassicPlaybar: (classicPlaybar) => set({ classicPlaybar }),
      setExperimentalRuAudioTextWarmup: (experimentalRuAudioTextWarmup) =>
        set({ experimentalRuAudioTextWarmup }),
      setSoundwavePresetKey: (soundwavePresetKey) => set({ soundwavePresetKey }),
      setLanguageFilterEnabled: (languageFilterEnabled) => set({ languageFilterEnabled }),
      setPreferredLanguages: (preferredLanguages) =>
        set({ preferredLanguages: normalizePreferredLanguages(preferredLanguages) }),
      togglePreferredLanguage: (preferredLanguage) =>
        set((state) => {
          if (!preferredLanguage || preferredLanguage === 'all') {
            return { preferredLanguages: [] };
          }

          const normalized = preferredLanguage.trim().toLowerCase();
          const nextLanguages = state.preferredLanguages.includes(normalized)
            ? state.preferredLanguages.filter((lang) => lang !== normalized)
            : [...state.preferredLanguages, normalized];

          return { preferredLanguages: nextLanguages };
        }),
      setPreferredLanguage: (preferredLanguage) =>
        set({
          preferredLanguages: normalizePreferredLanguages(
            preferredLanguage === 'all' ? [] : preferredLanguage,
          ),
        }),
      setSoundwaveGenreStrict: (soundwaveGenreStrict) => set({ soundwaveGenreStrict }),
      setSoundwaveSelectedGenres: (soundwaveSelectedGenres) => set({ soundwaveSelectedGenres }),
      setSoundwaveHideLiked: (soundwaveHideLiked) => set({ soundwaveHideLiked }),
      resetTheme: () =>
        set({
          accentColor: DEFAULTS.accentColor,
          bgPrimary: DEFAULTS.bgPrimary,
          themePreset: DEFAULTS.themePreset,
          themeGradientEnabled: DEFAULTS.themeGradientEnabled,
          themeGradientFollowArtwork: DEFAULTS.themeGradientFollowArtwork,
          themeGradientType: DEFAULTS.themeGradientType,
          themeGradientColorA: DEFAULTS.themeGradientColorA,
          themeGradientColorB: DEFAULTS.themeGradientColorB,
          themeGradientColorC: DEFAULTS.themeGradientColorC,
          themeGradientAngle: DEFAULTS.themeGradientAngle,
          themeGradientAnimated: DEFAULTS.themeGradientAnimated,
          themeGradientAnimation: DEFAULTS.themeGradientAnimation,
          themeGradientSpeed: DEFAULTS.themeGradientSpeed,
          themeGlowEnabled: DEFAULTS.themeGlowEnabled,
          themeGlowIntensity: DEFAULTS.themeGlowIntensity,
          themeGlowOpacity: DEFAULTS.themeGlowOpacity,
          backgroundImage: DEFAULTS.backgroundImage,
          backgroundOpacity: DEFAULTS.backgroundOpacity,
          glassBlur: DEFAULTS.glassBlur,
        }),
    }),
    {
      name: 'sc-settings',
      storage: createJSONStorage(() => tauriStorage),
      version: 14,
      migrate: (persistedState) => {
        const state = (
          persistedState && typeof persistedState === 'object' ? persistedState : {}
        ) as Partial<SettingsState> & {
          preferredLanguage?: unknown;
          preferredLanguages?: unknown;
        };
        const decodedKey = decodeQdrantKeyFromStorage((state.qdrantKey as string) || '');
        const normalizedKey = decodedKey.trim();
        const qdrantKey =
          normalizedKey && normalizedKey !== ENV_QDRANT_KEY ? normalizedKey : DEFAULTS.qdrantKey;
        const qdrantUrl = normalizeQdrantUrl((state.qdrantUrl as string) || DEFAULTS.qdrantUrl);
        const preferredLanguages = normalizePreferredLanguages(
          Array.isArray(state.preferredLanguages)
            ? state.preferredLanguages
            : state.preferredLanguage,
        );
        const {
          preferredLanguage: _legacyPreferredLanguage,
          preferredLanguages: _preferredLanguages,
          ...restState
        } = state;
        return {
          ...DEFAULTS,
          ...restState,
          qdrantUrl,
          qdrantKey,
          preferredLanguages,
        };
      },
      merge: (persistedState, currentState) => {
        const state = (
          persistedState && typeof persistedState === 'object' ? persistedState : {}
        ) as Partial<SettingsState> & {
          preferredLanguage?: unknown;
          preferredLanguages?: unknown;
        };
        const decodedKey = decodeQdrantKeyFromStorage((state.qdrantKey as string) || '');
        const normalizedKey = decodedKey.trim();
        const qdrantKey =
          normalizedKey && normalizedKey !== ENV_QDRANT_KEY ? normalizedKey : DEFAULTS.qdrantKey;
        const qdrantUrl = normalizeQdrantUrl((state.qdrantUrl as string) || currentState.qdrantUrl);
        const preferredLanguages = normalizePreferredLanguages(
          Array.isArray(state.preferredLanguages)
            ? state.preferredLanguages
            : state.preferredLanguage,
        );
        const {
          preferredLanguage: _legacyPreferredLanguage,
          preferredLanguages: _preferredLanguages,
          ...restState
        } = state;
        return {
          ...currentState,
          ...restState,
          qdrantUrl,
          qdrantKey,
          preferredLanguages,
        };
      },
      partialize: (s) => ({
        accentColor: s.accentColor,
        bgPrimary: s.bgPrimary,
        themePreset: s.themePreset,
        themeGradientEnabled: s.themeGradientEnabled,
        themeGradientFollowArtwork: s.themeGradientFollowArtwork,
        themeGradientType: s.themeGradientType,
        themeGradientColorA: s.themeGradientColorA,
        themeGradientColorB: s.themeGradientColorB,
        themeGradientColorC: s.themeGradientColorC,
        themeGradientAngle: s.themeGradientAngle,
        themeGradientAnimated: s.themeGradientAnimated,
        themeGradientAnimation: s.themeGradientAnimation,
        themeGradientSpeed: s.themeGradientSpeed,
        themeGlowEnabled: s.themeGlowEnabled,
        themeGlowIntensity: s.themeGlowIntensity,
        themeGlowOpacity: s.themeGlowOpacity,
        backgroundImage: s.backgroundImage,
        backgroundOpacity: s.backgroundOpacity,
        glassBlur: s.glassBlur,
        language: s.language,
        eqEnabled: s.eqEnabled,
        eqGains: s.eqGains,
        eqPreset: s.eqPreset,
        normalizeVolume: s.normalizeVolume,
        highQualityStreaming: s.highQualityStreaming,
        spotifyClientId: s.spotifyClientId,
        youtubeClientId: s.youtubeClientId,
        youtubeClientSecret: s.youtubeClientSecret,
        soundcloudClientId: s.soundcloudClientId,
        soundcloudClientSecret: s.soundcloudClientSecret,
        apiMode: s.apiMode,
        customApiKey: s.customApiKey,
        sidebarCollapsed: s.sidebarCollapsed,
        crossfadeEnabled: s.crossfadeEnabled,
        crossfadeDuration: s.crossfadeDuration,
        floatingComments: s.floatingComments,
        discordRpc: s.discordRpc,
        discordRpcMode: s.discordRpcMode,
        discordRpcShowButton: s.discordRpcShowButton,
        discordRpcButtonMode: s.discordRpcButtonMode,
        qdrantEnabled: s.qdrantEnabled,
        qdrantUrl: s.qdrantUrl,
        qdrantKey: encodeQdrantKeyForStorage(s.qdrantKey),
        qdrantCollection: s.qdrantCollection,
        regionalTrendSeed: s.regionalTrendSeed,
        regionalTrendRegions: s.regionalTrendRegions,
        llmRerankEnabled: s.llmRerankEnabled,
        llmEndpoint: s.llmEndpoint,
        llmModel: s.llmModel,
        targetFramerate: s.targetFramerate,
        unlockFramerate: s.unlockFramerate,
        showFpsCounter: s.showFpsCounter,
        hardwareAcceleration: s.hardwareAcceleration,
        classicPlaybar: s.classicPlaybar,
        experimentalRuAudioTextWarmup: s.experimentalRuAudioTextWarmup,
        soundwavePresetKey: s.soundwavePresetKey,
        // Visualizer settings
        visualizerStyle: s.visualizerStyle,
        visualizerPlaybar: s.visualizerPlaybar,
        visualizerFullscreen: s.visualizerFullscreen,
        visualizerThemeColor: s.visualizerThemeColor,
        visualizerWidth: s.visualizerWidth,
        visualizerHeight: s.visualizerHeight,
        visualizerScale: s.visualizerScale,
        visualizerXOffset: s.visualizerXOffset,
        visualizerYOffset: s.visualizerYOffset,
        visualizerOpacity: s.visualizerOpacity,
        visualizerSmoothing: s.visualizerSmoothing,
        visualizerMirror: s.visualizerMirror,
        visualizerFade: s.visualizerFade,
        visualizerBars: s.visualizerBars,
        lowPerformanceMode: s.lowPerformanceMode,
        languageFilterEnabled: s.languageFilterEnabled,
        preferredLanguages: s.preferredLanguages,
        soundwaveGenreStrict: s.soundwaveGenreStrict,
        soundwaveSelectedGenres: s.soundwaveSelectedGenres,
        soundwaveHideLiked: s.soundwaveHideLiked,
      }),
    },
  ),
);
