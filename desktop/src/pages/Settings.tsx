import { invoke } from '@tauri-apps/api/core';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Skeleton } from '../components/ui/Skeleton.tsx';
import { reloadCurrentTrack } from '../lib/audio';
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
} from '../lib/cache';
import { Globe, Link, Loader2, Trash2, X } from '../lib/icons';
import { useAuthStore } from '../stores/auth';
import { THEME_PRESETS, useSettingsStore } from '../stores/settings';

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
  const [clearingAudio, setClearingAudio] = useState(false);
  const [clearingAssets, setClearingAssets] = useState(false);

  useEffect(() => {
    getCacheSize().then(setAudioSize);
    getAssetsCacheSize().then(setAssetsSize);
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

  const totalSize = (audioSize ?? 0) + (assetsSize ?? 0);

  return (
    <section className="bg-white/[0.02] border border-white/[0.05] backdrop-blur-[60px] rounded-3xl p-6 shadow-xl space-y-2">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[15px] font-bold text-white/80 tracking-tight">
          {t('settings.cache')}
        </h3>

        <div className="min-w-[80px] flex justify-end">
          {audioSize !== null && assetsSize !== null ? (
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

// Visualizer section has been moved to a separate component below with translations
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
        {sinks.map((sink) => (
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
            {sink.description}
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
  
  const setQdrantEnabled = useSettingsStore((s) => s.setQdrantEnabled);
  const setQdrantUrl = useSettingsStore((s) => s.setQdrantUrl);
  const setQdrantKey = useSettingsStore((s) => s.setQdrantKey);
  const setQdrantCollection = useSettingsStore((s) => s.setQdrantCollection);

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
              <p className="text-[11px] text-white/30">{t('settings.qdrantEnabledDesc', 'Use Qdrant for 72D vector search and mood analysis')}</p>
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
              <label className="text-[12px] text-white/40 font-medium ml-1">Qdrant URL</label>
              <input
                type="text"
                value={qdrantUrl}
                onChange={(e) => setQdrantUrl(e.target.value)}
                placeholder="https://xxx-yyy.us-east4-0.gcp.cloud.qdrant.io:6333"
                className="w-full px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.06] text-[13px] text-white/80 placeholder:text-white/15 focus:border-accent/40 focus:bg-white/[0.06] transition-all outline-none"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[12px] text-white/40 font-medium ml-1">API Key</label>
              <input
                type="password"
                value={qdrantKey}
                onChange={(e) => setQdrantKey(e.target.value)}
                placeholder="Your Qdrant API Key"
                className="w-full px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.06] text-[13px] text-white/80 placeholder:text-white/15 focus:border-accent/40 focus:bg-white/[0.06] transition-all outline-none"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[12px] text-white/40 font-medium ml-1">Collection Name</label>
              <input
                type="text"
                value={qdrantCollection}
                onChange={(e) => setQdrantCollection(e.target.value)}
                placeholder="sw_v1"
                className="w-full px-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.06] text-[13px] text-white/80 placeholder:text-white/15 focus:border-accent/40 focus:bg-white/[0.06] transition-all outline-none"
              />
            </div>
            
            <p className="text-[11px] text-white/20 italic leading-relaxed">
               {t('settings.qdrantNote', 'Note: You need a Qdrant Cloud cluster. Your tracks will be vectorized and indexed localy then synced to Qdrant.')}
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
  const targetFramerate = useSettingsStore((s) => s.targetFramerate);
  const unlockFramerate = useSettingsStore((s) => s.unlockFramerate);
  const showFpsCounter = useSettingsStore((s) => s.showFpsCounter);
  const hardwareAcceleration = useSettingsStore((s) => s.hardwareAcceleration);
  const setTargetFramerate = useSettingsStore((s) => s.setTargetFramerate);
  const setUnlockFramerate = useSettingsStore((s) => s.setUnlockFramerate);
  const setShowFpsCounter = useSettingsStore((s) => s.setShowFpsCounter);
  const setHardwareAcceleration = useSettingsStore((s) => s.setHardwareAcceleration);
  const classicPlaybar = useSettingsStore((s) => s.classicPlaybar);
  const setClassicPlaybar = useSettingsStore((s) => s.setClassicPlaybar);
  return (
    <section className="bg-white/[0.02] border border-white/[0.05] backdrop-blur-[60px] rounded-3xl p-6 shadow-xl space-y-5">
      <h3 className="text-[15px] font-bold text-white/80 tracking-tight">
        {t('settings.playback')}
      </h3>

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

      {/* Classic Playbar */}
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <p className="text-[13px] text-white/70 font-medium">{t('settings.classicPlaybar')}</p>
          <p className="text-[11px] text-white/30">{t('settings.classicPlaybarDesc')}</p>
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

      {/* Crossfade */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <p className="text-[13px] text-white/70 font-medium">{t('settings.crossfade', 'Crossfade Mode')}</p>
            <p className="text-[11px] text-white/30">{t('settings.crossfadeDesc', 'Smoothly fade between tracks')}</p>
          </div>
          <button
            onClick={() => useSettingsStore.getState().setCrossfadeEnabled(!useSettingsStore.getState().crossfadeEnabled)}
            className={`w-11 h-6 rounded-full transition-all duration-200 cursor-pointer relative ${
              useSettingsStore.getState().crossfadeEnabled ? 'bg-accent' : 'bg-white/10'
            }`}
          >
            <div
              className={`absolute top-0.5 w-5 h-5 rounded-full shadow-md transition-all duration-200 ${
                useSettingsStore.getState().crossfadeEnabled ? 'left-[22px] bg-accent-contrast' : 'left-0.5 bg-white'
              }`}
            />
          </button>
        </div>

        <div className={`transition-opacity duration-300 space-y-3 ${useSettingsStore.getState().crossfadeEnabled ? 'opacity-100' : 'opacity-30 pointer-events-none'}`}>
          <div className="flex items-center justify-between">
            <label className="text-[13px] text-white/60">{t('settings.crossfadeDuration', 'Duration')}</label>
            <span className="text-[12px] text-white/40 tabular-nums">{useSettingsStore.getState().crossfadeDuration}s</span>
          </div>
          <input
            type="range"
            min={1}
            max={15}
            step={1}
            value={useSettingsStore.getState().crossfadeDuration}
            onChange={(e) => useSettingsStore.getState().setCrossfadeDuration(Number(e.target.value))}
            className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-[var(--color-accent)]"
          />
        </div>
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
          ▶ Import from Spotify
        </button>
        <button
          onClick={() => setYtOpen(true)}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-[13px] font-semibold bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20 hover:border-red-500/30 transition-all duration-300 cursor-pointer"
        >
          ▶ Import from YouTube Music
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

/* ── Main ───────────────────────────────────────────────── */

export function Settings() {
  const { t } = useTranslation();

  return (
    <div className="p-6 pb-4 max-w-2xl mx-auto space-y-6">
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
      <AccountSection />
    </div>
  );
}
