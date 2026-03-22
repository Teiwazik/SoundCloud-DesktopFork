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

      {/* Audio Visualizer */}
      <div className="space-y-4 pt-4 border-t border-white/[0.05]">
        <h4 className="text-[13px] text-white/50 font-medium">{t('settings.visualizer') || 'Visualizer'}</h4>
        <div className="flex gap-2 bg-white/[0.04] p-1 rounded-xl">
          {['Off', 'Bars', 'Wave', 'Pulse'].map((style) => {
            const isActive = useSettingsStore((s) => s.visualizerStyle) === style;
            return (
              <button
                key={style}
                className={`flex-1 text-[12px] font-medium py-1.5 rounded-lg transition-all cursor-pointer ${
                  isActive
                    ? 'bg-white/10 text-white'
                    : 'text-white/40 hover:text-white/60'
                }`}
                onClick={() => useSettingsStore.getState().setVisualizerStyle(style as any)}
              >
                {style}
              </button>
            );
          })}
        </div>
        
        {/* Placement toggles */}
        <div className="flex items-center justify-between">
          <span className="text-[13px] text-white/60">{t('settings.visualizerPlaybar') || 'Show above playbar'}</span>
          <input
            type="checkbox"
            checked={useSettingsStore((s) => s.visualizerPlaybar)}
            onChange={(e) => useSettingsStore.getState().setVisualizerPlaybar(e.target.checked)}
            className="w-4 h-4 accent-[var(--color-accent)] cursor-pointer"
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[13px] text-white/60">{t('settings.visualizerFullscreen') || 'Show in Fullscreen'}</span>
          <input
            type="checkbox"
            checked={useSettingsStore((s) => s.visualizerFullscreen)}
            onChange={(e) => useSettingsStore.getState().setVisualizerFullscreen(e.target.checked)}
            className="w-4 h-4 accent-[var(--color-accent)] cursor-pointer"
          />
        </div>
        
        {/* Color & Mirror */}
        <div className="flex items-center justify-between pt-1">
          <span className="text-[13px] text-white/60">{'Use Theme Color'}</span>
          <input
            type="checkbox"
            checked={useSettingsStore((s) => s.visualizerThemeColor)}
            onChange={(e) => useSettingsStore.getState().setVisualizerThemeColor(e.target.checked)}
            className="w-4 h-4 accent-[var(--color-accent)] cursor-pointer"
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[13px] text-white/60">{'Mirror (flip horizontally)'}</span>
          <input
            type="checkbox"
            checked={useSettingsStore((s) => s.visualizerMirror)}
            onChange={(e) => useSettingsStore.getState().setVisualizerMirror(e.target.checked)}
            className="w-4 h-4 accent-[var(--color-accent)] cursor-pointer"
          />
        </div>

        {/* Width */}
        <div className="space-y-1 pt-1">
          <div className="flex items-center justify-between">
            <label className="text-[13px] text-white/60">{'Width'}</label>
            <span className="text-[12px] text-white/40 tabular-nums">{useSettingsStore((s) => s.visualizerWidth)}%</span>
          </div>
          <input type="range" min={20} max={100} step={5}
            value={useSettingsStore((s) => s.visualizerWidth)}
            onChange={(e) => useSettingsStore.getState().setVisualizerWidth(Number(e.target.value))}
            className="w-full accent-[var(--color-accent)] h-1 bg-white/10 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-lg"
          />
        </div>

        {/* Height */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="text-[13px] text-white/60">{'Height'}</label>
            <span className="text-[12px] text-white/40 tabular-nums">{useSettingsStore((s) => s.visualizerHeight)}px</span>
          </div>
          <input type="range" min={32} max={300} step={8}
            value={useSettingsStore((s) => s.visualizerHeight)}
            onChange={(e) => useSettingsStore.getState().setVisualizerHeight(Number(e.target.value))}
            className="w-full accent-[var(--color-accent)] h-1 bg-white/10 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-lg"
          />
        </div>

        {/* Scale */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="text-[13px] text-white/60">{'Scale'}</label>
            <span className="text-[12px] text-white/40 tabular-nums">{useSettingsStore((s) => s.visualizerScale)}%</span>
          </div>
          <input type="range" min={50} max={200} step={10}
            value={useSettingsStore((s) => s.visualizerScale)}
            onChange={(e) => useSettingsStore.getState().setVisualizerScale(Number(e.target.value))}
            className="w-full accent-[var(--color-accent)] h-1 bg-white/10 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-lg"
          />
        </div>

        {/* Opacity */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="text-[13px] text-white/60">{'Opacity'}</label>
            <span className="text-[12px] text-white/40 tabular-nums">{useSettingsStore((s) => s.visualizerOpacity)}%</span>
          </div>
          <input type="range" min={10} max={100} step={5}
            value={useSettingsStore((s) => s.visualizerOpacity)}
            onChange={(e) => useSettingsStore.getState().setVisualizerOpacity(Number(e.target.value))}
            className="w-full accent-[var(--color-accent)] h-1 bg-white/10 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-lg"
          />
        </div>

        {/* Smoothing */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="text-[13px] text-white/60">{'Smoothing'}</label>
            <span className="text-[12px] text-white/40 tabular-nums">{useSettingsStore((s) => s.visualizerSmoothing)}%</span>
          </div>
          <input type="range" min={5} max={80} step={5}
            value={useSettingsStore((s) => s.visualizerSmoothing)}
            onChange={(e) => useSettingsStore.getState().setVisualizerSmoothing(Number(e.target.value))}
            className="w-full accent-[var(--color-accent)] h-1 bg-white/10 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-lg"
          />
        </div>

        {/* Fade */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="text-[13px] text-white/60">{'Fade'}</label>
            <span className="text-[12px] text-white/40 tabular-nums">{useSettingsStore((s) => s.visualizerFade)}%</span>
          </div>
          <input type="range" min={0} max={100} step={5}
            value={useSettingsStore((s) => s.visualizerFade)}
            onChange={(e) => useSettingsStore.getState().setVisualizerFade(Number(e.target.value))}
            className="w-full accent-[var(--color-accent)] h-1 bg-white/10 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-lg"
          />
        </div>

        {/* Bar Count */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="text-[13px] text-white/60">{'Bar Count'}</label>
            <span className="text-[12px] text-white/40 tabular-nums">{useSettingsStore((s) => s.visualizerBars)}</span>
          </div>
          <input type="range" min={8} max={128} step={4}
            value={useSettingsStore((s) => s.visualizerBars)}
            onChange={(e) => useSettingsStore.getState().setVisualizerBars(Number(e.target.value))}
            className="w-full accent-[var(--color-accent)] h-1 bg-white/10 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-lg"
          />
        </div>

        {/* X-Offset */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="text-[13px] text-white/60">{'X-Offset'}</label>
            <span className="text-[12px] text-white/40 tabular-nums">{useSettingsStore((s) => s.visualizerXOffset)}px</span>
          </div>
          <input type="range" min={-500} max={500} step={10}
            value={useSettingsStore((s) => s.visualizerXOffset)}
            onChange={(e) => useSettingsStore.getState().setVisualizerXOffset(Number(e.target.value))}
            className="w-full accent-[var(--color-accent)] h-1 bg-white/10 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-lg"
          />
        </div>

        {/* Y-Offset */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="text-[13px] text-white/60">{'Y-Offset'}</label>
            <span className="text-[12px] text-white/40 tabular-nums">{useSettingsStore((s) => s.visualizerYOffset)}px</span>
          </div>
          <input type="range" min={-300} max={300} step={10}
            value={useSettingsStore((s) => s.visualizerYOffset)}
            onChange={(e) => useSettingsStore.getState().setVisualizerYOffset(Number(e.target.value))}
            className="w-full accent-[var(--color-accent)] h-1 bg-white/10 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-lg"
          />
        </div>
      </div>
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

/* ── Equalizer Section ───────────────────────────────────── */

const EQ_BANDS_LABELS = ['30Hz', '60Hz', '125Hz', '250Hz', '500Hz', '1kHz', '2kHz', '4kHz', '8kHz', '14kHz'];

const EqualizerSection = React.memo(function EqualizerSection() {
  const eqEnabled = useSettingsStore((s) => s.eqEnabled);
  const eqGains = useSettingsStore((s) => s.eqGains);
  const setEqEnabled = useSettingsStore((s) => s.setEqEnabled);
  const setEqBand = useSettingsStore((s) => s.setEqBand);
  const setEqGains = useSettingsStore((s) => s.setEqGains);

  return (
    <section className="bg-white/[0.02] border border-white/[0.05] backdrop-blur-[60px] rounded-3xl p-6 shadow-xl space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-[15px] font-bold text-white/80 tracking-tight">
          {'Equalizer'}
        </h3>
        <button
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
        <div className="flex items-end justify-between h-48 pt-6 pb-2 gap-1 overflow-x-auto relative">
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
            Reset to Flat
          </button>
        </div>
      </div>
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
      <PlaybackSection />
      <EqualizerSection />
      <AudioDeviceSection />
      <ImportSection />
      <AccountSection />
    </div>
  );
}
