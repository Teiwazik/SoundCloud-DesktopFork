import { invoke } from '@tauri-apps/api/core';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Skeleton } from '../components/ui/Skeleton.tsx';
import { reloadCurrentTrack } from '../lib/audio';
import { DEFAULT_API_BASE, getApiBase } from '../lib/constants';
import {
  clearAssetsCache,
  clearCache,
  downloadWallpaper,
  getAssetsCacheSize,
  getCacheSize,
  getWallpaperUrl,
  listWallpapers,
  removeWallpaper,
  saveWallpaperFromBuffer,
  getLyricsCacheSize,
  clearLyricsCache,
} from '../lib/cache';
import { fetchAllLikedTracks } from '../lib/hooks';
import { Globe, Link, Loader2, Trash2, X, Play, Pause, Square } from '../lib/icons';
import { useAuthStore } from '../stores/auth';
import { useCacheTaskStore } from '../stores/cache-task';

import {
  isDefaultQdrantKeyInUse,
  THEME_PRESETS,
  useSettingsStore,
  type DiscordRpcButtonMode,
  type DiscordRpcMode,
} from '../stores/settings';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const PRESET_COLORS = [
  '#ff5500',
  '#ff3366',
  '#7c3aed',
  '#3b82f6',
  '#06b6d4',
  '#10b981',
  '#eab308',
  '#ef4444',
  '#f97316',
  '#8b5cf6',
];

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'ru', label: 'Русский' },
  { code: 'tr', label: 'Turkce' },
  { code: 'uk', label: 'Українська' },
] as const;

const DISCORD_RPC_MODES: Array<{ id: DiscordRpcMode; labelKey: string }> = [
  { id: 'text', labelKey: 'settings.discordRpcModeText' },
  { id: 'track', labelKey: 'settings.discordRpcModeTrack' },
  { id: 'artist', labelKey: 'settings.discordRpcModeArtist' },
  { id: 'activity', labelKey: 'settings.discordRpcModeActivity' },
];

const DISCORD_RPC_BUTTON_MODES: Array<{ id: DiscordRpcButtonMode; labelKey: string }> = [
  { id: 'soundcloud', labelKey: 'settings.discordRpcButtonModeSoundcloud' },
  { id: 'app', labelKey: 'settings.discordRpcButtonModeApp' },
  { id: 'both', labelKey: 'settings.discordRpcButtonModeBoth' },
];

/* ── Language Section ─────────────────────────────────────── */

const LanguageSection = React.memo(function LanguageSection() {
  const { t, i18n } = useTranslation();

  return (
    <section className="bg-white/[0.02] border border-white/[0.05] backdrop-blur-[60px] rounded-3xl p-6 shadow-xl">
      <h3 className="text-[15px] font-bold text-white/80 tracking-tight mb-4">
        {t('settings.language')}
      </h3>
      <div className="flex gap-2">
        {LANGUAGES.map((lang) => (
          <button
            key={lang.code}
            onClick={() => i18n.changeLanguage(lang.code)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-[13px] font-semibold transition-all duration-200 cursor-pointer border ${
              i18n.language === lang.code
                ? 'bg-white/[0.1] text-white/90 border-white/[0.15]'
                : 'bg-white/[0.02] text-white/40 border-white/[0.05] hover:bg-white/[0.06] hover:text-white/60'
            }`}
          >
            <Globe size={14} strokeWidth={1.8} />
            {lang.label}
          </button>
        ))}
      </div>
    </section>
  );
});

/* ── Cache Section ──────────────────────────────────────── */

function CacheRow({
  label,
  size,
  clearing,
  onClear,
  t,
}: {
  label: string;
  size: number | null;
  clearing: boolean;
  onClear: () => void;
  t: (k: string) => string;
}) {
  return (
    <div className="flex items-center justify-between py-3">
      <div className="flex items-center gap-4">
        <div>
          <p className="text-[13px] text-white/60 font-medium">{label}</p>

          <div className="h-[25px] flex items-center">
            {size === null ? (
              <Skeleton className="w-25 h-[20px]" />
            ) : (
              <p className="text-[17px] font-bold text-white/90 tabular-nums">
                {formatBytes(size)}
              </p>
            )}
          </div>
        </div>
      </div>
      <button
        onClick={onClear}
        disabled={clearing || size === 0}
        className="flex items-center gap-2 px-4 py-2 rounded-xl text-[12px] font-semibold bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/10 hover:border-red-500/20 transition-all duration-300 disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"
      >
        {clearing ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
        {t('settings.clearCache')}
      </button>
    </div>
  );
}

const CacheSection = React.memo(function CacheSection() {
  const { t } = useTranslation();
  const [audioSize, setAudioSize] = useState<number | null>(null);
  const [assetsSize, setAssetsSize] = useState<number | null>(null);
  const [lyricsSize, setLyricsSize] = useState<number | null>(null);
  const [clearingAudio, setClearingAudio] = useState(false);
  const [clearingAssets, setClearingAssets] = useState(false);
  const [clearingLyrics, setClearingLyrics] = useState(false);
  const [cachingLikes, setCachingLikes] = useState(false);

  useEffect(() => {
    getCacheSize().then(setAudioSize);
    getAssetsCacheSize().then(setAssetsSize);
    getLyricsCacheSize().then(setLyricsSize);
  }, []);

  const handleClearAudio = useCallback(async () => {
    setClearingAudio(true);
    try {
      await clearCache();
      setAudioSize(0);
      toast.success(t('settings.cacheCleared'));
    } catch {
      toast.error(t('common.error'));
    } finally {
      setClearingAudio(false);
    }
  }, [t]);

  const handleClearAssets = useCallback(async () => {
    setClearingAssets(true);
    try {
      await clearAssetsCache();
      setAssetsSize(0);
      toast.success(t('settings.cacheCleared'));
    } catch {
      toast.error(t('common.error'));
    } finally {
      setClearingAssets(false);
    }
  }, [t]);

  const handleClearLyrics = useCallback(async () => {
    setClearingLyrics(true);
    try {
      await clearLyricsCache();
      setLyricsSize(0);
      toast.success(t('settings.cacheCleared'));
    } catch {
      toast.error(t('common.error'));
    } finally {
      setClearingLyrics(false);
    }
  }, [t]);

  const cacheTask = useCacheTaskStore();

  const handleCacheAllLiked = useCallback(async () => {
    setCachingLikes(true);
    try {
      const likedTracks = await fetchAllLikedTracks();
      cacheTask.startBatch(likedTracks.map((t) => t.urn));
    } catch {
      toast.error(t('common.error'));
    } finally {
      setCachingLikes(false);
    }
  }, [cacheTask, t]);

  const totalSize = (audioSize ?? 0) + (assetsSize ?? 0) + (lyricsSize ?? 0);

  return (
    <section className="bg-white/[0.02] border border-white/[0.05] backdrop-blur-[60px] rounded-3xl p-6 shadow-xl space-y-2">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[15px] font-bold text-white/80 tracking-tight">
          {t('settings.cache')}
        </h3>

        <div className="min-w-[80px] flex justify-end">
          {audioSize !== null && assetsSize !== null && lyricsSize !== null ? (
            <span className="text-[12px] text-white/30 tabular-nums">
              {t('settings.total')}: {formatBytes(totalSize)}
            </span>
          ) : (
            <Skeleton className="h-[12px] w-[80px]" />
          )}
        </div>
      </div>
      <CacheRow
        label={t('settings.audioCacheSize')}
        size={audioSize}
        clearing={clearingAudio}
        onClear={handleClearAudio}
        t={t}
      />
      <div className="border-t border-white/[0.04]" />
      <CacheRow
        label={t('settings.assetsCacheSize')}
        size={assetsSize}
        clearing={clearingAssets}
        onClear={handleClearAssets}
        t={t}
      />
      <div className="border-t border-white/[0.04]" />
      <CacheRow
        label={t('settings.lyricsCacheSize', 'Lyrics cache size')}
        size={lyricsSize}
        clearing={clearingLyrics}
        onClear={handleClearLyrics}
        t={t}
      />
      <div className="border-t border-white/[0.04]" />
      <div className="flex items-center justify-between gap-4 py-2">
        <div className="min-w-0">
          <p className="text-[13px] text-white/70 font-medium">{t('settings.cacheAllLiked')}</p>
          <p className="text-[11px] text-white/30">
            {cachingLikes 
              ? t('settings.loadingTracks', 'Loading tracks list...')
              : cacheTask.status !== 'idle'
                ? `${t('settings.cacheProgress', 'Progress')}: ${cacheTask.completed + cacheTask.skipped} / ${cacheTask.total} (${cacheTask.failed} failed)`
                : t('settings.cacheAllLikedDesc')}
          </p>
        </div>
        
        <div className="flex items-center gap-2">
          {cacheTask.status === 'idle' ? (
            <button
              type="button"
              onClick={handleCacheAllLiked}
              disabled={cachingLikes}
              className="shrink-0 rounded-xl border border-white/[0.08] bg-white/[0.05] px-4 py-2 text-[12px] font-semibold text-white/85 transition-all hover:bg-white/[0.09] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {cachingLikes ? t('settings.loading', 'Loading...') : t('settings.startCaching')}
            </button>
          ) : (
            <>
              {cacheTask.status === 'running' ? (
                <button
                  type="button"
                  onClick={() => cacheTask.pauseBatch()}
                  className="w-8 h-8 rounded-xl flex items-center justify-center border border-sky-500/30 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20 transition-all cursor-pointer"
                  title="Pause"
                >
                  <Pause size={14} fill="currentColor" strokeWidth={0} />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => cacheTask.resumeBatch()}
                  className="w-8 h-8 rounded-xl flex items-center justify-center border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 transition-all cursor-pointer"
                  title="Resume"
                >
                  <Play size={14} fill="currentColor" strokeWidth={0} className="ml-0.5" />
                </button>
              )}
              <button
                type="button"
                onClick={() => cacheTask.stopBatch()}
                className="w-8 h-8 rounded-xl flex items-center justify-center border border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20 transition-all cursor-pointer"
                title="Stop"
              >
                <Square size={12} fill="currentColor" strokeWidth={0} />
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
});

/* ── Wallpaper Picker ───────────────────────────────────── */

const WallpaperPicker = React.memo(function WallpaperPicker() {
  const { t } = useTranslation();
  const backgroundImage = useSettingsStore((s) => s.backgroundImage);
  const setBackgroundImage = useSettingsStore((s) => s.setBackgroundImage);

  const [wallpapers, setWallpapers] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [showUrlInput, setShowUrlInput] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listWallpapers().then((names) => {
      setWallpapers(names);
      setLoading(false);
    });
  }, []);

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const buffer = await file.arrayBuffer();
        const name = await saveWallpaperFromBuffer(buffer, file.name);
        setWallpapers((prev) => [...prev, name]);
        setBackgroundImage(name);
        toast.success(t('settings.wallpaperAdded'));
      } catch {
        toast.error(t('common.error'));
      }
      e.target.value = '';
    },
    [setBackgroundImage, t],
  );

  const handleDownloadUrl = useCallback(async () => {
    const url = urlInput.trim();
    if (!url) return;
    setDownloading(true);
    try {
      const name = await downloadWallpaper(url);
      setWallpapers((prev) => [...prev, name]);
      setBackgroundImage(name);
      setUrlInput('');
      setShowUrlInput(false);
      toast.success(t('settings.wallpaperAdded'));
    } catch {
      toast.error(t('settings.bgLoadError'));
    } finally {
      setDownloading(false);
    }
  }, [urlInput, setBackgroundImage, t]);

  const handleRemove = useCallback(
    async (name: string) => {
      await removeWallpaper(name);
      setWallpapers((prev) => prev.filter((w) => w !== name));
      if (backgroundImage === name) {
        setBackgroundImage('');
      }
    },
    [backgroundImage, setBackgroundImage],
  );

  const handleSelect = useCallback(
    (name: string) => {
      setBackgroundImage(backgroundImage === name ? '' : name);
    },
    [backgroundImage, setBackgroundImage],
  );

  return (
    <div className="space-y-3">
      <label className="text-[13px] text-white/50 font-medium">
        {t('settings.backgroundImage')}
      </label>

      {/* Wallpaper grid */}
      <div className="flex flex-wrap gap-3">
        {/* "None" option */}
        <button
          onClick={() => setBackgroundImage('')}
          className={`w-20 h-14 rounded-xl border-2 transition-all duration-200 cursor-pointer flex items-center justify-center ${
            !backgroundImage
              ? 'border-white/40 bg-white/[0.08]'
              : 'border-white/[0.06] bg-white/[0.02] hover:border-white/[0.12]'
          }`}
        >
          <span className="text-[10px] text-white/40 font-semibold">{t('settings.none')}</span>
        </button>

        {/* Saved wallpapers */}
        {wallpapers.map((name) => {
          const url = getWallpaperUrl(name);
          return (
            <div
              key={name}
              className={`relative group w-20 h-14 rounded-xl overflow-hidden border-2 transition-all duration-200 cursor-pointer ${
                backgroundImage === name
                  ? 'border-white/40 shadow-[0_0_12px_rgba(255,255,255,0.1)]'
                  : 'border-white/[0.06] hover:border-white/[0.15]'
              }`}
              onClick={() => handleSelect(name)}
            >
              {url && <img src={url} alt="" className="w-full h-full object-cover" />}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleRemove(name);
                }}
                className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/60 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer hover:bg-red-500/80"
              >
                <X size={8} className="text-white" />
              </button>
              {backgroundImage === name && (
                <div className="absolute inset-0 bg-white/10 flex items-center justify-center">
                  <div className="w-4 h-4 rounded-full bg-white shadow-lg" />
                </div>
              )}
            </div>
          );
        })}

        {loading && (
          <div className="w-20 h-14 rounded-xl bg-white/[0.02] border border-white/[0.06] flex items-center justify-center">
            <Loader2 size={14} className="animate-spin text-white/20" />
          </div>
        )}

        {/* Add from file */}
        <button
          onClick={() => fileInputRef.current?.click()}
          className="w-20 h-14 rounded-xl border-2 border-dashed border-white/[0.1] hover:border-white/[0.2] transition-all cursor-pointer flex flex-col items-center justify-center gap-0.5 hover:bg-white/[0.02]"
        >
          <span className="text-[14px] text-white/30 font-light leading-none">+</span>
          <span className="text-[9px] text-white/25 font-medium">{t('settings.addFile')}</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileSelect}
          className="hidden"
        />

        {/* Add from URL */}
        <button
          onClick={() => setShowUrlInput(!showUrlInput)}
          className={`w-20 h-14 rounded-xl border-2 border-dashed transition-all cursor-pointer flex flex-col items-center justify-center gap-0.5 ${
            showUrlInput
              ? 'border-white/[0.2] bg-white/[0.04]'
              : 'border-white/[0.1] hover:border-white/[0.2] hover:bg-white/[0.02]'
          }`}
        >
          <Link size={12} className="text-white/30" />
          <span className="text-[9px] text-white/25 font-medium">URL</span>
        </button>
      </div>

      {/* URL download input */}
      {showUrlInput && (
        <div className="flex gap-2 animate-fade-in-up">
          <input
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleDownloadUrl()}
            placeholder={t('settings.bgUrlPlaceholder')}
            className="flex-1 px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.06] text-[13px] text-white/80 placeholder:text-white/20 focus:border-white/[0.12] focus:bg-white/[0.06] transition-all duration-200 outline-none"
            autoFocus
          />
          <button
            onClick={handleDownloadUrl}
            disabled={downloading || !urlInput.trim()}
            className="px-4 py-2.5 rounded-xl text-[12px] font-semibold bg-white/[0.08] text-white/70 hover:bg-white/[0.12] border border-white/[0.06] transition-all disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"
          >
            {downloading ? <Loader2 size={14} className="animate-spin" /> : t('settings.download')}
          </button>
        </div>
      )}
    </div>
  );
});

/* ── Theme Section ──────────────────────────────────────── */

const THEME_PRESET_KEYS = ['soundcloud', 'dark', 'neon', 'forest', 'crimson'] as const;

const ThemeSection = React.memo(function ThemeSection() {
  const { t } = useTranslation();
  const accentColor = useSettingsStore((s) => s.accentColor);
  const themePreset = useSettingsStore((s) => s.themePreset);
  const backgroundImage = useSettingsStore((s) => s.backgroundImage);
  const backgroundOpacity = useSettingsStore((s) => s.backgroundOpacity);
  const setAccentColor = useSettingsStore((s) => s.setAccentColor);
  const setThemePreset = useSettingsStore((s) => s.setThemePreset);
  const setBackgroundOpacity = useSettingsStore((s) => s.setBackgroundOpacity);
  const resetTheme = useSettingsStore((s) => s.resetTheme);

  const colorInputRef = useRef<HTMLInputElement>(null);

  return (
    <section className="bg-white/[0.02] border border-white/[0.05] backdrop-blur-[60px] rounded-3xl p-6 shadow-xl space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-[15px] font-bold text-white/80 tracking-tight">
          {t('settings.appearance')}
        </h3>
        <button
          onClick={resetTheme}
          className="text-[12px] text-white/30 hover:text-white/60 transition-colors cursor-pointer"
        >
          {t('settings.resetDefaults')}
        </button>
      </div>

      {/* Theme Presets */}
      <div className="space-y-3">
        <label className="text-[13px] text-white/50 font-medium">{t('settings.themePreset')}</label>
        <div className="grid grid-cols-3 gap-3">
          {THEME_PRESET_KEYS.map((id) => {
            const def = THEME_PRESETS[id];
            const isActive = themePreset === id;
            return (
              <button
                key={id}
                onClick={() => setThemePreset(id)}
                className={`group relative rounded-2xl overflow-hidden border transition-all duration-200 cursor-pointer hover:scale-[1.03] active:scale-[0.97] ${
                  isActive
                    ? 'border-white/30 ring-1 ring-white/20'
                    : 'border-white/[0.06] hover:border-white/15'
                }`}
              >
                <div
                  className="relative h-16 overflow-hidden"
                  style={{ backgroundColor: def.preview[1] }}
                >
                  <div
                    className="absolute left-3 top-3 w-5 h-5 rounded-full"
                    style={{ backgroundColor: def.preview[0] }}
                  />
                  <div
                    className="absolute right-3 bottom-2 left-3 h-6 rounded-lg"
                    style={{ backgroundColor: def.preview[2] }}
                  />
                </div>
                <div className="px-3 py-2 bg-white/[0.03] text-center">
                  <span
                    className={`text-[12px] font-medium ${isActive ? 'text-white/90' : 'text-white/50'}`}
                  >
                    {def.name}
                  </span>
                </div>
              </button>
            );
          })}
          <button
            onClick={() => {
              setThemePreset('custom');
              colorInputRef.current?.click();
            }}
            className={`group relative rounded-2xl overflow-hidden border border-dashed transition-all duration-200 cursor-pointer hover:scale-[1.03] active:scale-[0.97] ${
              themePreset === 'custom'
                ? 'border-white/30 bg-white/[0.04]'
                : 'border-white/[0.1] hover:border-white/20'
            }`}
          >
            <div className="h-16 flex items-center justify-center">
              <span className="text-[20px] text-white/30 group-hover:text-white/50 transition-colors">
                +
              </span>
            </div>
            <div className="px-3 py-2 bg-white/[0.02] text-center">
              <span
                className={`text-[12px] font-medium ${themePreset === 'custom' ? 'text-white/90' : 'text-white/40'}`}
              >
                {t('settings.themeCustom')}
              </span>
            </div>
          </button>
        </div>
      </div>

      {/* Accent Color (for custom) */}
      {themePreset === 'custom' && (
        <div className="space-y-3">
          <label className="text-[13px] text-white/50 font-medium">
            {t('settings.accentColor')}
          </label>
          <div className="flex items-center gap-2 flex-wrap">
            {PRESET_COLORS.map((color) => (
              <button
                key={color}
                onClick={() => setAccentColor(color)}
                className="w-8 h-8 rounded-full border-2 transition-all duration-200 cursor-pointer hover:scale-110 active:scale-95 shadow-md"
                style={{
                  backgroundColor: color,
                  borderColor: accentColor === color ? 'white' : 'transparent',
                  boxShadow: accentColor === color ? `0 0 16px ${color}60` : undefined,
                }}
              />
            ))}
            <button
              onClick={() => colorInputRef.current?.click()}
              className="w-8 h-8 rounded-full border-2 border-dashed border-white/20 hover:border-white/40 transition-all cursor-pointer flex items-center justify-center text-white/30 hover:text-white/60 hover:scale-110"
            >
              <span className="text-[11px] font-bold">+</span>
            </button>
          </div>
        </div>
      )}
      <input
        ref={colorInputRef}
        type="color"
        value={accentColor}
        onChange={(e) => setAccentColor(e.target.value)}
        className="sr-only"
      />

      {/* Background Image */}
      <WallpaperPicker />

      {/* Background Opacity */}
      {backgroundImage && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-[13px] text-white/50 font-medium">
              {t('settings.bgOpacity')}
            </label>
            <span className="text-[12px] text-white/30 tabular-nums">
              {Math.round(backgroundOpacity * 100)}%
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={0.5}
            step={0.01}
            value={backgroundOpacity}
            onChange={(e) => setBackgroundOpacity(Number(e.target.value))}
            className="w-full accent-[var(--color-accent)] h-1 bg-white/10 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-lg"
          />
        </div>
      )}
    </section>
  );
});

/* ── Audio Device Section ──────────────────────────────── */

interface AudioSink {
  name: string;
  description: string;
  is_default: boolean;
}

const AudioDeviceSection = React.memo(function AudioDeviceSection() {
  const { t } = useTranslation();
  const [sinks, setSinks] = useState<AudioSink[]>([]);
  const [switching, setSwitching] = useState(false);

  const sinkOptions = React.useMemo(() => {
    const totalByLabel = new Map<string, number>();
    for (const sink of sinks) {
      const base = (sink.description || sink.name || '').trim() || t('settings.audioDeviceDefault');
      totalByLabel.set(base, (totalByLabel.get(base) || 0) + 1);
    }

    const seenByLabel = new Map<string, number>();
    return sinks.map((sink) => {
      const base = (sink.description || sink.name || '').trim() || t('settings.audioDeviceDefault');
      const seen = (seenByLabel.get(base) || 0) + 1;
      seenByLabel.set(base, seen);

      const total = totalByLabel.get(base) || 1;
      const label = total > 1 ? `${base} (${seen})` : base;
      return { sink, label };
    });
  }, [sinks, t]);

  const refreshSinks = React.useCallback(() => {
    invoke<AudioSink[]>('audio_list_devices').then(setSinks).catch(console.error);
  }, []);

  // Refresh on mount + when window regains focus (device may have changed)
  useEffect(() => {
    refreshSinks();
    const onFocus = () => refreshSinks();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshSinks]);

  const handleSwitch = async (sinkName: string) => {
    const current = sinks.find((s) => s.is_default);
    if (switching || current?.name === sinkName) return;
    setSwitching(true);
    try {
      await invoke('audio_switch_device', { deviceName: sinkName });
      setSinks((prev) => prev.map((s) => ({ ...s, is_default: s.name === sinkName })));
      await reloadCurrentTrack();
      toast.success(t('settings.audioDeviceSwitched'));
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSwitching(false);
    }
  };

  if (sinks.length === 0) return null;

  return (
    <section className="bg-white/[0.02] border border-white/[0.05] backdrop-blur-[60px] rounded-3xl p-6 shadow-xl">
      <h3 className="text-[15px] font-bold text-white/80 tracking-tight mb-4">
        {t('settings.audioDevice')}
      </h3>
      <div className="flex gap-2 flex-wrap">
        {sinkOptions.map(({ sink, label }) => (
          <button
            key={sink.name}
            onClick={() => handleSwitch(sink.name)}
            disabled={switching}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-[13px] font-semibold transition-all duration-200 cursor-pointer border ${
              sink.is_default
                ? 'bg-white/[0.1] text-white/90 border-white/[0.15]'
                : 'bg-white/[0.02] text-white/40 border-white/[0.05] hover:bg-white/[0.06] hover:text-white/60'
            } disabled:opacity-50`}
          >
            {label}
          </button>
        ))}
      </div>
    </section>
  );

});

/* ── SoundWave Section ────────────────────────────────── */

const SoundWaveSection = React.memo(function SoundWaveSection() {
  const { t } = useTranslation();
  const qdrantEnabled = useSettingsStore((s) => s.qdrantEnabled);
  const qdrantUrl = useSettingsStore((s) => s.qdrantUrl);
  const qdrantKey = useSettingsStore((s) => s.qdrantKey);
  const qdrantCollection = useSettingsStore((s) => s.qdrantCollection);
  const regionalTrendSeed = useSettingsStore((s) => s.regionalTrendSeed);
  const regionalTrendRegions = useSettingsStore((s) => s.regionalTrendRegions);
  const llmRerankEnabled = useSettingsStore((s) => s.llmRerankEnabled);
  const llmEndpoint = useSettingsStore((s) => s.llmEndpoint);
  const llmModel = useSettingsStore((s) => s.llmModel);
  
  const setQdrantEnabled = useSettingsStore((s) => s.setQdrantEnabled);
  const setQdrantUrl = useSettingsStore((s) => s.setQdrantUrl);
  const setQdrantKey = useSettingsStore((s) => s.setQdrantKey);
  const setQdrantCollection = useSettingsStore((s) => s.setQdrantCollection);
  const setRegionalTrendSeed = useSettingsStore((s) => s.setRegionalTrendSeed);
  const setRegionalTrendRegions = useSettingsStore((s) => s.setRegionalTrendRegions);
  const setLlmRerankEnabled = useSettingsStore((s) => s.setLlmRerankEnabled);
  const setLlmEndpoint = useSettingsStore((s) => s.setLlmEndpoint);
  const setLlmModel = useSettingsStore((s) => s.setLlmModel);

  const [open, setOpen] = useState(false);

  return (
    <section className="bg-white/[0.02] border border-white/[0.05] backdrop-blur-[60px] rounded-3xl shadow-xl overflow-hidden mt-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-6 py-5 hover:bg-white/[0.02] transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-3">
           <h3 className="text-[15px] font-bold text-white/80 tracking-tight">SoundWave (Pro)</h3>
           <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-accent/20 text-accent uppercase tracking-widest">Qdrant</span>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${qdrantEnabled ? 'bg-emerald-500/15 text-emerald-400' : 'bg-white/[0.05] text-white/30'}`}>
            {qdrantEnabled ? t('eq.on', 'On') : t('eq.off', 'Off')}
          </span>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className={`text-white/30 transition-transform duration-300 ${open ? 'rotate-180' : ''}`}>
            <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      </button>

      {open && (
        <div className="px-6 pb-6 space-y-5 border-t border-white/[0.05] pt-4 animate-fade-in-up">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <p className="text-[13px] text-white/70 font-medium">{t('settings.qdrantEnabled', 'Enable Recommendation Engine')}</p>
              <p className="text-[11px] text-white/30">{t('settings.qdrantEnabledDesc', 'Use Qdrant for 96D vector search, spectral analysis and mood adaptation')}</p>
            </div>
            <button
              onClick={() => setQdrantEnabled(!qdrantEnabled)}
              className={`w-11 h-6 rounded-full transition-all duration-200 cursor-pointer relative ${
                qdrantEnabled ? 'bg-accent' : 'bg-white/10'
              }`}
            >
              <div
                className={`absolute top-0.5 w-5 h-5 rounded-full shadow-md transition-all duration-200 ${
                  qdrantEnabled ? 'left-[22px] bg-accent-contrast' : 'left-0.5 bg-white'
                }`}
              />
            </button>
          </div>

          <div className={`space-y-4 transition-opacity duration-300 ${!qdrantEnabled ? 'opacity-30 pointer-events-none' : 'opacity-100'}`}>
            <div className="space-y-1.5">
              <label className="text-[12px] text-white/40 font-medium ml-1">
                {t('settings.qdrantUrlLabel', 'Qdrant URL')}
              </label>
              <input
                type="text"
                value={qdrantUrl}
                onChange={(e) => setQdrantUrl(e.target.value)}
                placeholder={t(
                  'settings.qdrantUrlPlaceholder',
                  'http://localhost:6333 or https://xxx.cloud.qdrant.io:6333',
                )}
                className="w-full px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.06] text-[13px] text-white/80 placeholder:text-white/15 focus:border-accent/40 focus:bg-white/[0.06] transition-all outline-none"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[12px] text-white/40 font-medium ml-1">
                {t('settings.qdrantKeyLabel', 'API Key')}
              </label>
              <input
                type="password"
                value={qdrantKey}
                onChange={(e) => setQdrantKey(e.target.value)}
                placeholder={t(
                  'settings.qdrantKeyPlaceholderDefault',
                  'Default key is currently in use. Enter your own to override.',
                )}
                className="w-full px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.06] text-[13px] text-white/80 placeholder:text-white/15 focus:border-accent/40 focus:bg-white/[0.06] transition-all outline-none"
              />
              {isDefaultQdrantKeyInUse(qdrantKey) && (
                <p className="text-[11px] text-white/30 ml-1">
                  {t(
                    'settings.qdrantKeyDefaultHint',
                    'Field is empty: built-in default key is active right now.',
                  )}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-[12px] text-white/40 font-medium ml-1">
                {t('settings.qdrantCollectionLabel', 'Collection Name')}
              </label>
              <input
                type="text"
                value={qdrantCollection}
                onChange={(e) => setQdrantCollection(e.target.value)}
                placeholder={t('settings.qdrantCollectionPlaceholder', 'sw_v2')}
                className="w-full px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.06] text-[13px] text-white/80 placeholder:text-white/15 focus:border-accent/40 focus:bg-white/[0.06] transition-all outline-none"
              />
            </div>

            <div className="border-t border-white/[0.05] pt-4 space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <p className="text-[13px] text-white/70 font-medium">
                    {t('settings.regionalTrendSeed', 'Cross-platform regional trend seeding')}
                  </p>
                  <p className="text-[11px] text-white/30">
                    {t('settings.regionalTrendSeedDesc', 'Parse Apple/Deezer charts by regions and blend into discovery pool')}
                  </p>
                </div>
                <button
                  onClick={() => setRegionalTrendSeed(!regionalTrendSeed)}
                  className={`w-11 h-6 rounded-full transition-all duration-200 cursor-pointer relative ${
                    regionalTrendSeed ? 'bg-accent' : 'bg-white/10'
                  }`}
                >
                  <div
                    className={`absolute top-0.5 w-5 h-5 rounded-full shadow-md transition-all duration-200 ${
                      regionalTrendSeed ? 'left-[22px] bg-accent-contrast' : 'left-0.5 bg-white'
                    }`}
                  />
                </button>
              </div>

              <div className="space-y-1.5">
                <label className="text-[12px] text-white/40 font-medium ml-1">
                  {t('settings.regionalTrendRegions', 'Regions (ISO2, comma separated)')}
                </label>
                <input
                  type="text"
                  value={regionalTrendRegions}
                  onChange={(e) => setRegionalTrendRegions(e.target.value)}
                  placeholder="us,gb,de,fr,br,jp,kr,mx"
                  className="w-full px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.06] text-[13px] text-white/80 placeholder:text-white/15 focus:border-accent/40 focus:bg-white/[0.06] transition-all outline-none"
                />
              </div>
            </div>

            <div className="border-t border-white/[0.05] pt-4 space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <p className="text-[13px] text-white/70 font-medium">
                    {t('settings.llmRerankEnabled', 'Enable LLM reranking')}
                  </p>
                  <p className="text-[11px] text-white/30">
                    {t('settings.llmRerankEnabledDesc', 'Rerank recommendation candidates with a local LLM for better mood fit and diversity')}
                  </p>
                </div>
                <button
                  onClick={() => setLlmRerankEnabled(!llmRerankEnabled)}
                  className={`w-11 h-6 rounded-full transition-all duration-200 cursor-pointer relative ${
                    llmRerankEnabled ? 'bg-accent' : 'bg-white/10'
                  }`}
                >
                  <div
                    className={`absolute top-0.5 w-5 h-5 rounded-full shadow-md transition-all duration-200 ${
                      llmRerankEnabled ? 'left-[22px] bg-accent-contrast' : 'left-0.5 bg-white'
                    }`}
                  />
                </button>
              </div>

              <div className={`space-y-4 transition-opacity duration-300 ${!llmRerankEnabled ? 'opacity-40 pointer-events-none' : 'opacity-100'}`}>
                <div className="space-y-1.5">
                  <label className="text-[12px] text-white/40 font-medium ml-1">LLM Endpoint</label>
                  <input
                    type="text"
                    value={llmEndpoint}
                    onChange={(e) => setLlmEndpoint(e.target.value)}
                    placeholder="http://127.0.0.1:11434"
                    className="w-full px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.06] text-[13px] text-white/80 placeholder:text-white/15 focus:border-accent/40 focus:bg-white/[0.06] transition-all outline-none"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-[12px] text-white/40 font-medium ml-1">LLM Model</label>
                  <input
                    type="text"
                    value={llmModel}
                    onChange={(e) => setLlmModel(e.target.value)}
                    placeholder="qwen2.5:14b"
                    className="w-full px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.06] text-[13px] text-white/80 placeholder:text-white/15 focus:border-accent/40 focus:bg-white/[0.06] transition-all outline-none"
                  />
                </div>
              </div>
            </div>
            
            <p className="text-[11px] text-white/20 italic leading-relaxed">
               {t('settings.qdrantNote', 'Note: You can use either Qdrant Cloud or a local Qdrant server. Tracks are vectorized locally, enriched with spectral features, and synced to the selected collection.')}
            </p>
          </div>
        </div>
      )}
    </section>
  );
});

/* ── Playback Section ─────────────────────────────────── */

const PlaybackSection = React.memo(function PlaybackSection() {
  const { t } = useTranslation();
  const floatingComments = useSettingsStore((s) => s.floatingComments);
  const setFloatingComments = useSettingsStore((s) => s.setFloatingComments);
  const normalizeVolume = useSettingsStore((s) => s.normalizeVolume);
  const setNormalizeVolume = useSettingsStore((s) => s.setNormalizeVolume);
  const highQualityStreaming = useSettingsStore((s) => s.highQualityStreaming);
  const setHighQualityStreaming = useSettingsStore((s) => s.setHighQualityStreaming);
  const discordRpc = useSettingsStore((s) => s.discordRpc);
  const setDiscordRpc = useSettingsStore((s) => s.setDiscordRpc);
  const discordRpcMode = useSettingsStore((s) => s.discordRpcMode);
  const setDiscordRpcMode = useSettingsStore((s) => s.setDiscordRpcMode);
  const discordRpcShowButton = useSettingsStore((s) => s.discordRpcShowButton);
  const setDiscordRpcShowButton = useSettingsStore((s) => s.setDiscordRpcShowButton);
  const discordRpcButtonMode = useSettingsStore((s) => s.discordRpcButtonMode);
  const setDiscordRpcButtonMode = useSettingsStore((s) => s.setDiscordRpcButtonMode);
  const targetFramerate = useSettingsStore((s) => s.targetFramerate);
  const unlockFramerate = useSettingsStore((s) => s.unlockFramerate);
  const showFpsCounter = useSettingsStore((s) => s.showFpsCounter);
  const hardwareAcceleration = useSettingsStore((s) => s.hardwareAcceleration);
  const lowPerformanceMode = useSettingsStore((s) => s.lowPerformanceMode);
  const setTargetFramerate = useSettingsStore((s) => s.setTargetFramerate);
  const setUnlockFramerate = useSettingsStore((s) => s.setUnlockFramerate);
  const setShowFpsCounter = useSettingsStore((s) => s.setShowFpsCounter);
  const setHardwareAcceleration = useSettingsStore((s) => s.setHardwareAcceleration);
  const setLowPerformanceMode = useSettingsStore((s) => s.setLowPerformanceMode);
  const crossfadeEnabled = useSettingsStore((s) => s.crossfadeEnabled);
  const crossfadeDuration = useSettingsStore((s) => s.crossfadeDuration);
  const setCrossfadeEnabled = useSettingsStore((s) => s.setCrossfadeEnabled);
  const setCrossfadeDuration = useSettingsStore((s) => s.setCrossfadeDuration);
  const classicPlaybar = useSettingsStore((s) => s.classicPlaybar);
  const setClassicPlaybar = useSettingsStore((s) => s.setClassicPlaybar);
  return (
    <section className="bg-white/[0.02] border border-white/[0.05] backdrop-blur-[60px] rounded-3xl p-6 shadow-xl space-y-5">
      <h3 className="text-[15px] font-bold text-white/80 tracking-tight">
        {t('settings.playback')}
      </h3>

      {/* Classic Playbar */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[13px] text-white/70 font-medium">{t('settings.classicPlaybar')}</p>
          <p className="text-[11px] text-white/30 mt-0.5">{t('settings.classicPlaybarDesc')}</p>
        </div>
        <button
          onClick={() => setClassicPlaybar(!classicPlaybar)}
          className={`w-11 h-6 rounded-full transition-all duration-200 cursor-pointer relative ${
            classicPlaybar ? 'bg-accent' : 'bg-white/10'
          }`}
        >
          <div
            className={`absolute top-0.5 w-5 h-5 rounded-full shadow-md transition-all duration-200 ${
              classicPlaybar ? 'left-[22px] bg-accent-contrast' : 'left-0.5 bg-white'
            }`}
          />
        </button>
      </div>

      <div className="border-t border-white/[0.04]" />

      {/* Floating Comments */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[13px] text-white/70 font-medium">{t('settings.floatingComments')}</p>
          <p className="text-[11px] text-white/30 mt-0.5">{t('settings.floatingCommentsDesc')}</p>
        </div>
        <button
          onClick={() => setFloatingComments(!floatingComments)}
          className={`w-11 h-6 rounded-full transition-all duration-200 cursor-pointer relative ${
            floatingComments ? 'bg-accent' : 'bg-white/10'
          }`}
        >
          <div
            className={`absolute top-0.5 w-5 h-5 rounded-full shadow-md transition-all duration-200 ${
              floatingComments ? 'left-[22px] bg-accent-contrast' : 'left-0.5 bg-white'
            }`}
          />
        </button>
      </div>

      <div className="border-t border-white/[0.04]" />

      <div className="flex items-center justify-between">
        <div>
          <p className="text-[13px] text-white/70 font-medium">{t('settings.normalizeVolume', 'Normalize Volume')}</p>
          <p className="text-[11px] text-white/30 mt-0.5">{t('settings.normalizeVolumeDesc', 'Level loudness between tracks')}</p>
        </div>
        <button
          onClick={() => setNormalizeVolume(!normalizeVolume)}
          className={`w-11 h-6 rounded-full transition-all duration-200 cursor-pointer relative ${
            normalizeVolume ? 'bg-accent' : 'bg-white/10'
          }`}
        >
          <div
            className={`absolute top-0.5 w-5 h-5 rounded-full shadow-md transition-all duration-200 ${
              normalizeVolume ? 'left-[22px] bg-accent-contrast' : 'left-0.5 bg-white'
            }`}
          />
        </button>
      </div>

      <div className="border-t border-white/[0.04]" />

      <div className="flex items-center justify-between">
        <div>
          <p className="text-[13px] text-white/70 font-medium">{t('settings.highQualityStreaming')}</p>
          <p className="text-[11px] text-white/30 mt-0.5">{t('settings.highQualityStreamingDesc')}</p>
        </div>
        <button
          onClick={() => setHighQualityStreaming(!highQualityStreaming)}
          className={`w-11 h-6 rounded-full transition-all duration-200 cursor-pointer relative ${
            highQualityStreaming ? 'bg-accent' : 'bg-white/10'
          }`}
        >
          <div
            className={`absolute top-0.5 w-5 h-5 rounded-full shadow-md transition-all duration-200 ${
              highQualityStreaming ? 'left-[22px] bg-accent-contrast' : 'left-0.5 bg-white'
            }`}
          />
        </button>
      </div>

      <div className="border-t border-white/[0.04]" />

      {/* Crossfade */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <p className="text-[13px] text-white/70 font-medium">{t('settings.crossfade')}</p>
            <p className="text-[11px] text-white/30">{t('settings.crossfadeDesc')}</p>
          </div>
          <button
            onClick={() => setCrossfadeEnabled(!crossfadeEnabled)}
            className={`w-11 h-6 rounded-full transition-all duration-200 cursor-pointer relative ${
              crossfadeEnabled ? 'bg-accent' : 'bg-white/10'
            }`}
          >
            <div
              className={`absolute top-0.5 w-5 h-5 rounded-full shadow-md transition-all duration-200 ${
                crossfadeEnabled ? 'left-[22px] bg-accent-contrast' : 'left-0.5 bg-white'
              }`}
            />
          </button>
        </div>

        <div className={`transition-opacity duration-300 space-y-3 ${crossfadeEnabled ? 'opacity-100' : 'opacity-30 pointer-events-none'}`}>
          <div className="flex items-center justify-between">
            <label className="text-[13px] text-white/60">{t('settings.crossfadeDuration')}</label>
            <span className="text-[12px] text-white/40 tabular-nums">{crossfadeDuration}s</span>
          </div>
          <input
            type="range"
            min={1}
            max={15}
            step={1}
            value={crossfadeDuration}
            onChange={(e) => setCrossfadeDuration(Number(e.target.value))}
            className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-[var(--color-accent)]"
          />
        </div>
      </div>

      <div className="border-t border-white/[0.04]" />

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[13px] text-white/70 font-medium">{t('settings.discordRpc', 'Discord Rich Presence')}</p>
            <p className="text-[11px] text-white/30 mt-0.5">{t('settings.discordRpcDesc', 'Show what you are listening to in Discord')}</p>
          </div>
          <button
            onClick={() => setDiscordRpc(!discordRpc)}
            className={`w-11 h-6 rounded-full transition-all duration-200 cursor-pointer relative ${
              discordRpc ? 'bg-accent' : 'bg-white/10'
            }`}
          >
            <div
              className={`absolute top-0.5 w-5 h-5 rounded-full shadow-md transition-all duration-200 ${
                discordRpc ? 'left-[22px] bg-accent-contrast' : 'left-0.5 bg-white'
              }`}
            />
          </button>
        </div>

        {discordRpc && (
          <>
            <div className="space-y-2">
              <p className="text-[13px] text-white/50 font-medium">{t('settings.discordRpcMode', 'Display Mode')}</p>
              <div className="grid grid-cols-2 gap-2">
                {DISCORD_RPC_MODES.map((mode) => {
                  const active = discordRpcMode === mode.id;
                  return (
                    <button
                      key={mode.id}
                      onClick={() => setDiscordRpcMode(mode.id)}
                      className={`rounded-2xl border px-3 py-2.5 text-[12px] font-semibold transition-all duration-200 cursor-pointer ${
                        active
                          ? 'border-white/[0.16] bg-white/[0.08] text-white/90'
                          : 'border-white/[0.05] bg-white/[0.02] text-white/45 hover:bg-white/[0.05] hover:text-white/70'
                      }`}
                    >
                      {t(mode.labelKey)}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="text-[13px] text-white/70 font-medium">
                  {t('settings.discordRpcButton', 'Show RPC buttons')}
                </p>
                <p className="text-[11px] text-white/30 mt-0.5">
                  {t('settings.discordRpcButtonDesc', 'Adds action buttons to presence')}
                </p>
              </div>
              <button
                onClick={() => setDiscordRpcShowButton(!discordRpcShowButton)}
                className={`w-11 h-6 rounded-full transition-all duration-200 cursor-pointer relative ${
                  discordRpcShowButton ? 'bg-accent' : 'bg-white/10'
                }`}
              >
                <div
                  className={`absolute top-0.5 w-5 h-5 rounded-full shadow-md transition-all duration-200 ${
                    discordRpcShowButton ? 'left-[22px] bg-accent-contrast' : 'left-0.5 bg-white'
                  }`}
                />
              </button>
            </div>

            {discordRpcShowButton && (
              <div className="space-y-2">
                <p className="text-[13px] text-white/50 font-medium">
                  {t('settings.discordRpcButtonMode', 'Button action')}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {DISCORD_RPC_BUTTON_MODES.map((mode) => {
                    const active = discordRpcButtonMode === mode.id;
                    return (
                      <button
                        key={mode.id}
                        onClick={() => setDiscordRpcButtonMode(mode.id)}
                        className={`rounded-2xl border px-3 py-2.5 text-[12px] font-semibold transition-all duration-200 cursor-pointer ${
                          active
                            ? 'border-white/[0.16] bg-white/[0.08] text-white/90'
                            : 'border-white/[0.05] bg-white/[0.02] text-white/45 hover:bg-white/[0.05] hover:text-white/70'
                        }`}
                      >
                        {t(mode.labelKey)}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div className="border-t border-white/[0.04]" />

      <div className="flex items-center justify-between">
        <div className="space-y-1 pr-4">
          <p className="text-[13px] text-white/70 font-medium">
            {t('settings.lowPerformanceMode')}
          </p>
          <p className="text-[11px] text-white/30">
            {t('settings.lowPerformanceModeDesc')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setLowPerformanceMode(!lowPerformanceMode)}
          className={`w-11 h-6 rounded-full transition-all duration-200 cursor-pointer relative ${
            lowPerformanceMode ? 'bg-accent' : 'bg-white/10'
          }`}
        >
          <div
            className={`absolute top-0.5 w-5 h-5 rounded-full shadow-md transition-all duration-200 ${
              lowPerformanceMode ? 'left-[22px] bg-accent-contrast' : 'left-0.5 bg-white'
            }`}
          />
        </button>
      </div>

      <div className="border-t border-white/[0.04]" />

      {/* FPS Setting */}
      <div className="flex items-center gap-4">
        <div className="flex-1 space-y-3">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <p className="text-[13px] text-white/70 font-medium">
                {t('settings.framerateLimit', 'Framerate Limit')}
              </p>
              <p className="text-[11px] text-accent/80 font-medium">
                {t('settings.requiresRestart', 'Requires app restart')}
              </p>
            </div>
            <span className="text-[12px] text-white/30 tabular-nums">
              {unlockFramerate ? 'Unlimited' : `${targetFramerate} FPS`}
            </span>
          </div>
          <input
            type="range"
            min={15}
            max={240}
            step={5}
            value={targetFramerate}
            onChange={(e) => setTargetFramerate(Number(e.target.value))}
            disabled={unlockFramerate}
            className={`w-full accent-[var(--color-accent)] h-1 bg-white/10 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-lg transition-opacity ${
              unlockFramerate ? 'opacity-30' : ''
            }`}
          />
        </div>
        
        <div className="flex items-center gap-2 pt-6">
          <label className="text-[12px] text-white/50 cursor-pointer flex items-center gap-2">
            <input
              type="checkbox"
              checked={unlockFramerate}
              onChange={(e) => setUnlockFramerate(e.target.checked)}
              className="accent-[var(--color-accent)] w-4 h-4 cursor-pointer"
            />
            {t('settings.unlockLimit', 'Unlock Limit')}
          </label>
        </div>
      </div>

      <div className="border-t border-white/[0.04] my-6" />

      <div className="flex items-center justify-between">
        <div className="space-y-1 pr-4">
          <p className="text-[13px] text-white/70 font-medium">
            {t('settings.showFpsCounter', 'Show FPS Counter')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowFpsCounter(!showFpsCounter)}
          className={`w-11 h-6 rounded-full transition-all duration-200 cursor-pointer relative ${
            showFpsCounter ? 'bg-accent' : 'bg-white/10'
          }`}
        >
          <div
            className={`absolute top-0.5 w-5 h-5 rounded-full shadow-md transition-all duration-200 ${
              showFpsCounter ? 'left-[22px] bg-accent-contrast' : 'left-0.5 bg-white'
            }`}
          />
        </button>
      </div>

      <div className="border-t border-white/[0.04] my-6" />

      <div className="flex items-center justify-between">
        <div className="space-y-1 pr-4">
          <p className="text-[13px] text-white/70 font-medium">
            {t('settings.hardwareAcceleration', 'Hardware Acceleration')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setHardwareAcceleration(!hardwareAcceleration)}
          className={`w-11 h-6 rounded-full transition-all duration-200 cursor-pointer relative ${
            hardwareAcceleration ? 'bg-accent' : 'bg-white/10'
          }`}
        >
          <div
            className={`absolute top-0.5 w-5 h-5 rounded-full shadow-md transition-all duration-200 ${
              hardwareAcceleration ? 'left-[22px] bg-accent-contrast' : 'left-0.5 bg-white'
            }`}
          />
        </button>
      </div>
    </section>
  );
});

/* ── Import Section ──────────────────────────────────────── */

const ImportSection = React.memo(function ImportSection() {
  const { t } = useTranslation();
  const [ymOpen, setYmOpen] = useState(false);
  const [spotifyOpen, setSpotifyOpen] = useState(false);
  const [ytOpen, setYtOpen] = useState(false);

  return (
    <section className="bg-white/[0.02] border border-white/[0.05] backdrop-blur-[60px] rounded-3xl p-6 shadow-xl">
      <h3 className="text-[15px] font-bold text-white/80 tracking-tight mb-4">
        {t('settings.import')}
      </h3>
      <div className="flex flex-wrap gap-3">
        <button
          onClick={() => setYmOpen(true)}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-[13px] font-semibold bg-white/[0.06] text-white/70 hover:bg-white/[0.1] border border-white/[0.06] hover:border-white/[0.12] transition-all duration-300 cursor-pointer"
        >
          {t('settings.importYandex')}
        </button>
        <button
          onClick={() => setSpotifyOpen(true)}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-[13px] font-semibold bg-[#1db954]/10 text-[#1db954] hover:bg-[#1db954]/20 border border-[#1db954]/20 hover:border-[#1db954]/30 transition-all duration-300 cursor-pointer"
        >
          ▶ {t('importExternal.spotifyTitle')}
        </button>
        <button
          onClick={() => setYtOpen(true)}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-[13px] font-semibold bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20 hover:border-red-500/30 transition-all duration-300 cursor-pointer"
        >
          ▶ {t('importExternal.youtubeTitle')}
        </button>
      </div>
      {ymOpen && (
        <React.Suspense fallback={null}>
          <YMImportDialogLazy open={ymOpen} onOpenChange={setYmOpen} />
        </React.Suspense>
      )}
      {spotifyOpen && (
        <React.Suspense fallback={null}>
          <SpotifyImportDialogLazy open={spotifyOpen} onOpenChange={setSpotifyOpen} />
        </React.Suspense>
      )}
      {ytOpen && (
        <React.Suspense fallback={null}>
          <YTMusicImportDialogLazy open={ytOpen} onOpenChange={setYtOpen} />
        </React.Suspense>
      )}
    </section>
  );
});

const YMImportDialogLazy = React.lazy(() => import('../components/music/YMImportDialog'));
const SpotifyImportDialogLazy = React.lazy(() => import('../components/music/SpotifyImportDialog'));
const YTMusicImportDialogLazy = React.lazy(() => import('../components/music/YTMusicImportDialog'));

/* ── Account Section ────────────────────────────────────── */

const AccountSection = React.memo(function AccountSection() {
  const { t } = useTranslation();
  const logout = useAuthStore((s) => s.logout);

  return (
    <section className="bg-white/[0.02] border border-white/[0.05] backdrop-blur-[60px] rounded-3xl p-6 shadow-xl">
      <h3 className="text-[15px] font-bold text-white/80 tracking-tight mb-5">
        {t('settings.account')}
      </h3>
      <button
        onClick={logout}
        className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-[13px] font-semibold bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/10 hover:border-red-500/20 transition-all duration-300 cursor-pointer"
      >
        {t('auth.signOut')}
      </button>
    </section>
  );
});



/* ── Visualizer Section ──────────────────────────────────── */

const VisualizerSection = React.memo(function VisualizerSection() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  // All hooks must be called unconditionally (Rules of Hooks)
  const style        = useSettingsStore((s) => s.visualizerStyle);
  const playbar      = useSettingsStore((s) => s.visualizerPlaybar);
  const fullscreen   = useSettingsStore((s) => s.visualizerFullscreen);
  const themeColor   = useSettingsStore((s) => s.visualizerThemeColor);
  const mirror       = useSettingsStore((s) => s.visualizerMirror);
  const width        = useSettingsStore((s) => s.visualizerWidth);
  const height       = useSettingsStore((s) => s.visualizerHeight);
  const scale        = useSettingsStore((s) => s.visualizerScale);
  const opacity      = useSettingsStore((s) => s.visualizerOpacity);
  const smoothing    = useSettingsStore((s) => s.visualizerSmoothing);
  const fade         = useSettingsStore((s) => s.visualizerFade);
  const bars         = useSettingsStore((s) => s.visualizerBars);
  const xOffset      = useSettingsStore((s) => s.visualizerXOffset);
  const yOffset      = useSettingsStore((s) => s.visualizerYOffset);
  const isOff = style === 'Off';

  return (
    <section className="bg-white/[0.02] border border-white/[0.05] backdrop-blur-[60px] rounded-3xl shadow-xl overflow-hidden mt-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-6 py-5 hover:bg-white/[0.02] transition-colors cursor-pointer"
      >
        <h3 className="text-[15px] font-bold text-white/80 tracking-tight">{t('visualizer.title', 'Audio Visualizer')}</h3>
        <div className="flex items-center gap-3">
          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${!isOff ? 'bg-emerald-500/15 text-emerald-400' : 'bg-white/[0.05] text-white/30'}`}>
            {!isOff ? t('eq.on', 'On') : t('eq.off', 'Off')}
          </span>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className={`text-white/30 transition-transform duration-300 ${open ? 'rotate-180' : ''}`}>
            <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      </button>

      {open && (
        <div className="px-6 pb-6 space-y-4 border-t border-white/[0.05] pt-4 animate-fade-in-up">
          <div className="flex gap-2 bg-white/[0.04] p-1 rounded-xl">
            {['Off', 'Bars', 'Wave', 'Pulse'].map((s) => {
              const isActive = style === s;
              const label = s === 'Off' ? t('visualizer.off', 'Off') 
                         : s === 'Bars' ? t('visualizer.bars', 'Bars') 
                         : s === 'Wave' ? t('visualizer.wave', 'Wave') 
                         : t('visualizer.pulse', 'Pulse');
              return (
                <button
                  key={s}
                  className={`flex-1 text-[12px] font-medium py-1.5 rounded-lg transition-all cursor-pointer ${
                    isActive ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/60'
                  }`}
                  onClick={() => useSettingsStore.getState().setVisualizerStyle(s as any)}
                >
                  {label}
                </button>
              );
            })}
          </div>
          
          <div className={`space-y-4 transition-opacity duration-300 ${isOff ? 'opacity-30 pointer-events-none' : 'opacity-100'}`}>
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-white/60">{t('visualizer.showAbovePlaybar', 'Show above playbar')}</span>
              <input type="checkbox" checked={playbar} onChange={(e) => useSettingsStore.getState().setVisualizerPlaybar(e.target.checked)} className="w-4 h-4 accent-[var(--color-accent)] cursor-pointer" />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-white/60">{t('visualizer.showInFullscreen', 'Show in Fullscreen')}</span>
              <input type="checkbox" checked={fullscreen} onChange={(e) => useSettingsStore.getState().setVisualizerFullscreen(e.target.checked)} className="w-4 h-4 accent-[var(--color-accent)] cursor-pointer" />
            </div>
            <div className="flex items-center justify-between pt-1">
              <span className="text-[13px] text-white/60">{t('visualizer.useThemeColor', 'Use Theme Color')}</span>
              <input type="checkbox" checked={themeColor} onChange={(e) => useSettingsStore.getState().setVisualizerThemeColor(e.target.checked)} className="w-4 h-4 accent-[var(--color-accent)] cursor-pointer" />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-white/60">{t('visualizer.mirror', 'Mirror (flip horizontally)')}</span>
              <input type="checkbox" checked={mirror} onChange={(e) => useSettingsStore.getState().setVisualizerMirror(e.target.checked)} className="w-4 h-4 accent-[var(--color-accent)] cursor-pointer" />
            </div>

            <div className="space-y-1 pt-1">
              <div className="flex items-center justify-between">
                <label className="text-[13px] text-white/60">{t('visualizer.width', 'Width')}</label>
                <span className="text-[12px] text-white/40 tabular-nums">{width}%</span>
              </div>
              <input type="range" min={20} max={100} step={5} value={width} onChange={(e) => useSettingsStore.getState().setVisualizerWidth(Number(e.target.value))} className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-[var(--color-accent)]" />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[13px] text-white/60">{t('visualizer.height', 'Height')}</label>
                <span className="text-[12px] text-white/40 tabular-nums">{height}px</span>
              </div>
              <input type="range" min={32} max={300} step={8} value={height} onChange={(e) => useSettingsStore.getState().setVisualizerHeight(Number(e.target.value))} className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-[var(--color-accent)]" />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[13px] text-white/60">{t('visualizer.scale', 'Scale')}</label>
                <span className="text-[12px] text-white/40 tabular-nums">{scale}%</span>
              </div>
              <input type="range" min={50} max={200} step={10} value={scale} onChange={(e) => useSettingsStore.getState().setVisualizerScale(Number(e.target.value))} className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-[var(--color-accent)]" />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[13px] text-white/60">{t('visualizer.opacity', 'Opacity')}</label>
                <span className="text-[12px] text-white/40 tabular-nums">{opacity}%</span>
              </div>
              <input type="range" min={10} max={100} step={5} value={opacity} onChange={(e) => useSettingsStore.getState().setVisualizerOpacity(Number(e.target.value))} className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-[var(--color-accent)]" />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[13px] text-white/60">{t('visualizer.smoothing', 'Smoothing')}</label>
                <span className="text-[12px] text-white/40 tabular-nums">{smoothing}%</span>
              </div>
              <input type="range" min={5} max={80} step={5} value={smoothing} onChange={(e) => useSettingsStore.getState().setVisualizerSmoothing(Number(e.target.value))} className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-[var(--color-accent)]" />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[13px] text-white/60">{t('visualizer.fade', 'Fade')}</label>
                <span className="text-[12px] text-white/40 tabular-nums">{fade}%</span>
              </div>
              <input type="range" min={0} max={100} step={5} value={fade} onChange={(e) => useSettingsStore.getState().setVisualizerFade(Number(e.target.value))} className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-[var(--color-accent)]" />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[13px] text-white/60">{t('visualizer.barCount', 'Bar Count')}</label>
                <span className="text-[12px] text-white/40 tabular-nums">{bars}</span>
              </div>
              <input type="range" min={8} max={128} step={4} value={bars} onChange={(e) => useSettingsStore.getState().setVisualizerBars(Number(e.target.value))} className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-[var(--color-accent)]" />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[13px] text-white/60">{t('visualizer.xOffset', 'X-Offset')}</label>
                <span className="text-[12px] text-white/40 tabular-nums">{xOffset}px</span>
              </div>
              <input type="range" min={-500} max={500} step={10} value={xOffset} onChange={(e) => useSettingsStore.getState().setVisualizerXOffset(Number(e.target.value))} className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-[var(--color-accent)]" />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[13px] text-white/60">{t('visualizer.yOffset', 'Y-Offset')}</label>
                <span className="text-[12px] text-white/40 tabular-nums">{yOffset}px</span>
              </div>
              <input type="range" min={-300} max={300} step={10} value={yOffset} onChange={(e) => useSettingsStore.getState().setVisualizerYOffset(Number(e.target.value))} className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-[var(--color-accent)]" />
            </div>
          </div>
        </div>
      )}
    </section>
  );
});

/* ── Equalizer Section ───────────────────────────────────── */

const EQ_BANDS_LABELS = ['30Hz', '60Hz', '125Hz', '250Hz', '500Hz', '1kHz', '2kHz', '4kHz', '8kHz', '14kHz'];

const EqualizerSection = React.memo(function EqualizerSection() {
  const { t } = useTranslation();
  const eqEnabled = useSettingsStore((s) => s.eqEnabled);
  const eqGains = useSettingsStore((s) => s.eqGains);
  const setEqEnabled = useSettingsStore((s) => s.setEqEnabled);
  const setEqBand = useSettingsStore((s) => s.setEqBand);
  const setEqGains = useSettingsStore((s) => s.setEqGains);
  const [open, setOpen] = useState(false);

  return (
    <section className="bg-white/[0.02] border border-white/[0.05] backdrop-blur-[60px] rounded-3xl shadow-xl overflow-hidden mt-6">
      {/* Collapsible Header */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-6 py-5 hover:bg-white/[0.02] transition-colors cursor-pointer"
      >
        <h3 className="text-[15px] font-bold text-white/80 tracking-tight">{t('eq.title', 'Equalizer')}</h3>
        <div className="flex items-center gap-3">
          {/* EQ enabled badge */}
          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${eqEnabled ? 'bg-emerald-500/15 text-emerald-400' : 'bg-white/[0.05] text-white/30'}`}>
            {eqEnabled ? t('eq.on', 'On') : t('eq.off', 'Off')}
          </span>
          {/* Chevron */}
          <svg
            width="14" height="14" viewBox="0 0 14 14" fill="none"
            className={`text-white/30 transition-transform duration-300 ${open ? 'rotate-180' : ''}`}
          >
            <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      </button>

      {/* Collapsible Body */}
      {open && (
        <div className="px-6 pb-6 space-y-4 border-t border-white/[0.05] pt-4 animate-fade-in-up">
          {/* Enable toggle */}
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-white/60">{t('eq.enableEqualizer', 'Enable Equalizer')}</span>
            <button
              type="button"
              onClick={() => setEqEnabled(!eqEnabled)}
              className={`w-11 h-6 rounded-full transition-all duration-200 cursor-pointer relative ${
                eqEnabled ? 'bg-accent' : 'bg-white/10'
              }`}
            >
              <div
                className={`absolute top-0.5 w-5 h-5 rounded-full shadow-md transition-all duration-200 ${
                  eqEnabled ? 'left-[22px] bg-accent-contrast' : 'left-0.5 bg-white'
                }`}
              />
            </button>
          </div>

          <div className={`transition-opacity duration-300 ${eqEnabled ? 'opacity-100' : 'opacity-30 pointer-events-none'}`}>
            <div className="flex items-end justify-between h-48 pt-2 pb-2 gap-1 overflow-x-auto relative">
              {eqGains.map((gain, i) => (
                <div key={i} className="flex flex-col items-center justify-end h-full gap-3 flex-1 min-w-[28px]">
                  <span className="text-[10px] text-white/40 font-medium tabular-nums">{gain > 0 ? `+${gain.toFixed(1)}` : gain.toFixed(1)}</span>
                  <input
                    type="range"
                    min={-12}
                    max={12}
                    step={0.5}
                    value={gain}
                    onChange={(e) => setEqBand(i, parseFloat(e.target.value))}
                    className="w-1.5 h-28 accent-[var(--color-accent)] bg-white/10 rounded-full cursor-pointer hover:bg-white/20 transition-colors"
                    style={{ WebkitAppearance: 'slider-vertical' }}
                  />
                  <span className="text-[10px] text-white/50 font-semibold">{EQ_BANDS_LABELS[i]}</span>
                </div>
              ))}
            </div>

            <div className="flex justify-end pt-4 border-t border-white/[0.05] mt-2">
              <button
                onClick={() => setEqGains([0,0,0,0,0,0,0,0,0,0])}
                className="text-[12px] font-medium text-white/40 hover:text-white/80 transition-colors cursor-pointer"
              >
                {t('eq.resetToFlat', 'Reset to Flat')}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
});

const ApiSection = React.memo(function ApiSection() {
  const { t } = useTranslation();
  const apiMode = useSettingsStore((s) => s.apiMode);
  const customApiKey = useSettingsStore((s) => s.customApiKey);
  const setApiMode = useSettingsStore((s) => s.setApiMode);
  const setCustomApiKey = useSettingsStore((s) => s.setCustomApiKey);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success(t('auth.copied'));
  };

  return (
    <section className="bg-white/[0.02] border border-white/[0.05] backdrop-blur-[60px] rounded-3xl p-6 shadow-xl space-y-4">
      <div>
        <h3 className="text-[15px] font-bold text-white/80 tracking-tight">{t('settings.apiServer')}</h3>
        <p className="mt-1 text-[12px] text-white/35">{t('settings.apiServerDesc')}</p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {(['auto', 'custom'] as const).map((mode) => {
          const active = apiMode === mode;
          return (
            <button
              key={mode}
              type="button"
              onClick={() => setApiMode(mode)}
              className={`rounded-2xl border px-4 py-3 text-[12px] font-semibold transition-all ${
                active
                  ? 'border-white/[0.14] bg-white/[0.09] text-white/90'
                  : 'border-white/[0.05] bg-white/[0.03] text-white/45 hover:bg-white/[0.05] hover:text-white/70'
              }`}
            >
              {mode === 'auto' ? t('settings.apiModeAuto') : t('settings.apiModeCustom')}
            </button>
          );
        })}
      </div>

      <div className="rounded-2xl border border-white/[0.05] bg-white/[0.03] p-4 space-y-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/28">
            {t('settings.currentApiServer')}
          </p>
          <p className="mt-1 text-[13px] text-white/80 break-all">{getApiBase()}</p>
        </div>

        {apiMode === 'custom' ? (
          <div className="space-y-4 animate-fade-in-up">
            <div className="space-y-2">
              <label className="text-[11px] font-semibold uppercase tracking-[0.1em] text-white/40 ml-1">
                SoundCloud Client ID
              </label>
              <input
                type="text"
                value={customApiKey}
                onChange={(e) => setCustomApiKey(e.target.value)}
                placeholder="y5Z..."
                className="w-full rounded-2xl border border-white/[0.06] bg-white/[0.04] px-4 py-3 text-[13px] text-white/85 placeholder:text-white/20 outline-none transition-all focus:border-white/[0.12] focus:bg-white/[0.06]"
              />
            </div>

            <div className="space-y-2 bg-white/[0.03] border border-white/[0.05] rounded-2xl p-4">
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] font-semibold uppercase tracking-[0.1em] text-white/40">
                  {t('settings.apiSetupInfo')}
                </label>
                <button
                  onClick={() => copyToClipboard('https://api-v2.soundcloud.com/tracks?client_id=')}
                  className="text-[10px] font-bold text-accent hover:text-accent-hover transition-colors uppercase tracking-widest"
                >
                  {t('auth.copyLink')}
                </button>
              </div>
              <div className="bg-black/20 rounded-xl p-3 border border-white/[0.04]">
                <code className="text-[11px] text-white/60 break-all leading-relaxed">
                  https://api-v2.soundcloud.com/tracks?client_id=
                </code>
              </div>
              <p className="text-[10px] text-white/25 leading-normal">
                {t('settings.apiSetupDesc')}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-[12px] text-white/30">{DEFAULT_API_BASE}</p>
        )}
      </div>
    </section>
  );
});

/* ── Main ───────────────────────────────────────────────── */

export function Settings() {
  const { t } = useTranslation();

  return (
    <div className="p-6 pb-32 max-w-2xl mx-auto space-y-6">
      <h1 className="text-3xl font-extrabold text-white tracking-tight">{t('settings.title')}</h1>
      <LanguageSection />
      <CacheSection />
      <ThemeSection />
      <VisualizerSection />
      <SoundWaveSection />
      <PlaybackSection />
      <EqualizerSection />
      <AudioDeviceSection />
      <ImportSection />
      <ApiSection />

      <AccountSection />
    </div>
  );
}
