import { invoke } from '@tauri-apps/api/core';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useSubscription } from '../lib/subscription';
import { Skeleton } from '../components/ui/Skeleton.tsx';
import { useArtworkGradientPalette } from '../lib/artwork-palette';
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
import { Globe, Link, Loader2, Smartphone, Trash2, X, Play, Pause, Square } from '../lib/icons';
import { useAuthStore } from '../stores/auth';
import { useCacheTaskStore } from '../stores/cache-task';

import {
  APP_FONT_SIZE_DEFAULT,
  APP_FONT_SIZE_MAX,
  APP_FONT_SIZE_MIN,
  APP_UI_SCALE_DEFAULT,
  APP_UI_SCALE_MAX,
  APP_UI_SCALE_MIN,
  APP_ICON_VARIANTS,
  DEFAULT_FONT_STACK,
  THEME_PRESETS,
  useSettingsStore,
  type AppFontMode,
  type AppIconVariant,
  type DiscordRpcButtonMode,
  type DiscordRpcMode,
  type ThemeGradientAnimation,
  type ThemeGradientType,
} from '../stores/settings';
import { usePlayerStore } from '../stores/player';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function normalizeHexColor(hex: string): string {
  const value = hex.trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    const [, r, g, b] = value;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return '#ffffff';
}

function hexToRgba(hex: string, alpha: number): string {
  const normalized = normalizeHexColor(hex);
  const r = Number.parseInt(normalized.slice(1, 3), 16);
  const g = Number.parseInt(normalized.slice(3, 5), 16);
  const b = Number.parseInt(normalized.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
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

/* ── App Icon Section ───────────────────────────────────── */

interface CustomIcon {
  path: string;
  thumb: string; // blob: URL
}

const AppIconSection = React.memo(function AppIconSection() {
  const { t } = useTranslation();
  const appIcon = useSettingsStore((s) => s.appIcon);
  const setAppIcon = useSettingsStore((s) => s.setAppIcon);
  const customAppIconPath = useSettingsStore((s) => s.customAppIconPath);
  const setCustomAppIconPath = useSettingsStore((s) => s.setCustomAppIconPath);
  const [customIcons, setCustomIcons] = useState<CustomIcon[]>([]);

  // Re-apply on appIcon change. For 'custom' we route through the runtime
  // loader; for built-ins the bundled-image swap is cheap.
  useEffect(() => {
    if (appIcon === 'custom' && customAppIconPath) {
      invoke('set_custom_app_icon', { path: customAppIconPath }).catch(() => {});
    } else {
      invoke('set_app_icon', { variant: appIcon }).catch(() => {});
    }
  }, [appIcon, customAppIconPath]);

  // Load all saved custom icons from `<appData>/custom-icons/` into memory as
  // blob URLs. Files are tiny (≤256×256 PNG), so reading them all upfront is
  // fine — and avoids the asset:// protocol which would need extra config.
  const reloadCustomIcons = useCallback(async () => {
    try {
      const fs = await import('@tauri-apps/plugin-fs');
      const pathApi = await import('@tauri-apps/api/path');
      const dir = await pathApi.join(await pathApi.appDataDir(), 'custom-icons');
      if (!(await fs.exists(dir))) {
        setCustomIcons([]);
        return;
      }
      const entries = await fs.readDir(dir);
      const next: CustomIcon[] = [];
      for (const entry of entries) {
        if (!entry.isFile || !entry.name) continue;
        if (!/\.(png|ico)$/i.test(entry.name)) continue;
        const full = await pathApi.join(dir, entry.name);
        try {
          const bytes = await fs.readFile(full);
          const mime = entry.name.toLowerCase().endsWith('.ico') ? 'image/x-icon' : 'image/png';
          const blob = new Blob([bytes], { type: mime });
          next.push({ path: full, thumb: URL.createObjectURL(blob) });
        } catch {
          // skip unreadable
        }
      }
      // Sort by path so order is stable across renders (filenames embed a ms
      // timestamp, so this is also chronological — newest last).
      next.sort((a, b) => a.path.localeCompare(b.path));
      setCustomIcons((prev) => {
        for (const p of prev) URL.revokeObjectURL(p.thumb);
        return next;
      });
    } catch (e) {
      console.error('[appIcon] reloadCustomIcons failed', e);
    }
  }, []);

  useEffect(() => {
    void reloadCustomIcons();
    return () => {
      // Revoke any blob URLs still in state when the section unmounts.
      setCustomIcons((prev) => {
        for (const p of prev) URL.revokeObjectURL(p.thumb);
        return [];
      });
    };
  }, [reloadCustomIcons]);

  const onPick = useCallback(
    (id: AppIconVariant) => {
      if (id === appIcon) return;
      setAppIcon(id);
      invoke('set_app_icon', { variant: id }).catch(() => {});
    },
    [appIcon, setAppIcon],
  );

  const applyCustom = useCallback(
    async (path: string) => {
      try {
        await invoke('set_custom_app_icon', { path });
        setCustomAppIconPath(path);
        setAppIcon('custom');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        toast.error(`${t('settings.appIconCustomFailed')}: ${msg}`);
      }
    },
    [setAppIcon, setCustomAppIconPath, t],
  );

  const onChooseCustom = useCallback(async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'PNG / ICO', extensions: ['png', 'ico'] }],
      });
      if (!picked || typeof picked !== 'string') return;

      // Copy via Rust — the source path is arbitrary (Downloads, Desktop, …)
      // and isn't covered by our plugin-fs scope, but Rust uses std::fs.
      const dest = await invoke<string>('copy_custom_app_icon', { src: picked });
      await invoke('set_custom_app_icon', { path: dest });
      setCustomAppIconPath(dest);
      setAppIcon('custom');
      await reloadCustomIcons();
      toast.success(t('settings.appIconCustomApplied'));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`${t('settings.appIconCustomFailed')}: ${msg}`);
      console.error('[appIcon] custom pick failed', e);
    }
  }, [setAppIcon, setCustomAppIconPath, reloadCustomIcons, t]);

  const onDeleteCustom = useCallback(
    async (path: string, e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        const fs = await import('@tauri-apps/plugin-fs');
        await fs.remove(path);
        // If the deleted icon is currently active, revert to default.
        if (customAppIconPath === path) {
          setCustomAppIconPath(null);
          setAppIcon('default');
          invoke('set_app_icon', { variant: 'default' }).catch(() => {});
        }
        await reloadCustomIcons();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(`${t('settings.appIconCustomFailed')}: ${msg}`);
      }
    },
    [customAppIconPath, setAppIcon, setCustomAppIconPath, reloadCustomIcons, t],
  );

  return (
    <section className="bg-white/[0.02] border border-white/[0.05] backdrop-blur-[60px] rounded-3xl p-6 shadow-xl">
      <h3 className="text-[15px] font-bold text-white/80 tracking-tight">
        {t('settings.appIconHeader')}
      </h3>
      <p className="text-[12px] text-white/40 mt-1 mb-4">{t('settings.appIconDesc')}</p>
      <div className="grid grid-cols-5 gap-3">
        {APP_ICON_VARIANTS.map(({ id, labelKey }) => {
          const active = appIcon === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onPick(id)}
              className={`group flex flex-col items-center gap-2 p-3 rounded-2xl transition-all duration-200 cursor-pointer border ${
                active
                  ? 'bg-white/[0.08] border-white/[0.18] ring-1 ring-accent/40'
                  : 'bg-white/[0.02] border-white/[0.05] hover:bg-white/[0.05] hover:border-white/[0.1]'
              }`}
              aria-pressed={active}
            >
              <div
                className={`relative w-14 h-14 rounded-xl overflow-hidden bg-black/30 ring-1 transition-all ${
                  active ? 'ring-accent/30' : 'ring-white/[0.04] group-hover:ring-white/[0.1]'
                }`}
              >
                <img
                  src={`/app-icons/${id}.png`}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="w-full h-full object-contain"
                />
              </div>
              <span
                className={`text-[11px] font-medium text-center leading-tight transition-colors ${
                  active ? 'text-white/90' : 'text-white/45 group-hover:text-white/70'
                }`}
              >
                {t(labelKey)}
              </span>
            </button>
          );
        })}

        {customIcons.map(({ path, thumb }) => {
          const active = appIcon === 'custom' && customAppIconPath === path;
          const fileName = path.split(/[\\/]/).pop() || path;
          return (
            <div
              key={path}
              className={`group relative flex flex-col items-center gap-2 p-3 rounded-2xl transition-all duration-200 cursor-pointer border ${
                active
                  ? 'bg-white/[0.08] border-white/[0.18] ring-1 ring-accent/40'
                  : 'bg-white/[0.02] border-white/[0.05] hover:bg-white/[0.05] hover:border-white/[0.1]'
              }`}
              onClick={() => applyCustom(path)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  void applyCustom(path);
                }
              }}
              aria-pressed={active}
              title={fileName}
            >
              <div
                className={`relative w-14 h-14 rounded-xl overflow-hidden bg-black/30 ring-1 transition-all ${
                  active ? 'ring-accent/30' : 'ring-white/[0.04] group-hover:ring-white/[0.1]'
                }`}
              >
                <img src={thumb} alt="" className="w-full h-full object-contain" />
              </div>
              <span
                className={`text-[11px] font-medium text-center leading-tight transition-colors truncate max-w-full ${
                  active ? 'text-white/90' : 'text-white/45 group-hover:text-white/70'
                }`}
              >
                {t('settings.appIconCustom')}
              </span>
              <button
                type="button"
                onClick={(e) => onDeleteCustom(path, e)}
                className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-black/60 text-white/70 hover:bg-red-500/80 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer"
                aria-label={t('settings.appIconCustomDelete')}
                title={t('settings.appIconCustomDelete')}
              >
                <X size={12} strokeWidth={2.5} />
              </button>
            </div>
          );
        })}

        <button
          type="button"
          onClick={onChooseCustom}
          className="group flex flex-col items-center gap-2 p-3 rounded-2xl transition-all duration-200 cursor-pointer border bg-white/[0.02] border-white/[0.05] border-dashed hover:bg-white/[0.05] hover:border-white/[0.1]"
        >
          <div className="relative w-14 h-14 rounded-xl overflow-hidden bg-black/30 ring-1 ring-white/[0.04] group-hover:ring-white/[0.1] transition-all flex items-center justify-center">
            <span className="text-[28px] text-white/40 leading-none font-light">+</span>
          </div>
          <span className="text-[11px] font-medium text-center leading-tight text-white/45 group-hover:text-white/70 transition-colors">
            {t('settings.appIconAdd')}
          </span>
        </button>
      </div>
      <p className="text-[11px] text-white/30 mt-4">{t('settings.appIconFormatHint')}</p>
    </section>
  );
});

/* ── App Font Section ───────────────────────────────────── */

interface SystemFontEntry {
  family: string;
  path: string;
}

interface CustomFontEntry {
  path: string;
  family: string;
  blobUrl: string;
}

const FONT_PREVIEW_SAMPLE = 'AaBbCc 0123 — Привет';

const AppFontSection = React.memo(function AppFontSection() {
  const { t } = useTranslation();
  const mode = useSettingsStore((s) => s.appFontMode);
  const systemFamily = useSettingsStore((s) => s.appFontSystemFamily);
  const customPath = useSettingsStore((s) => s.appFontCustomPath);
  const customFamily = useSettingsStore((s) => s.appFontCustomFamily);
  const size = useSettingsStore((s) => s.appFontSize);
  const uiScale = useSettingsStore((s) => s.appUiScale);
  const setMode = useSettingsStore((s) => s.setAppFontMode);
  const setSystemFamily = useSettingsStore((s) => s.setAppFontSystemFamily);
  const setCustom = useSettingsStore((s) => s.setAppFontCustom);
  const setSize = useSettingsStore((s) => s.setAppFontSize);
  const setUiScale = useSettingsStore((s) => s.setAppUiScale);

  const [systemFonts, setSystemFonts] = useState<SystemFontEntry[]>([]);
  const [systemLoading, setSystemLoading] = useState(false);
  const [customFonts, setCustomFonts] = useState<CustomFontEntry[]>([]);
  const [systemQuery, setSystemQuery] = useState('');
  const [systemOpen, setSystemOpen] = useState(false);

  // Lazy-fetch system fonts the first time the user opens the dropdown —
  // scanning every TTF on the OS can take 1–2s on machines with thousands.
  const ensureSystemFonts = useCallback(async () => {
    if (systemFonts.length > 0 || systemLoading) return;
    setSystemLoading(true);
    try {
      const list = await invoke<SystemFontEntry[]>('list_system_fonts');
      setSystemFonts(list);
    } catch (e) {
      console.error('[appFont] list_system_fonts failed', e);
    } finally {
      setSystemLoading(false);
    }
  }, [systemFonts.length, systemLoading]);

  // Load saved custom fonts (in `<appData>/fonts/`) and register an
  // @font-face for each so the preview text in the picker tile actually
  // renders in that font.
  const reloadCustomFonts = useCallback(async () => {
    try {
      const fs = await import('@tauri-apps/plugin-fs');
      const pathApi = await import('@tauri-apps/api/path');
      const dir = await pathApi.join(await pathApi.appDataDir(), 'fonts');
      if (!(await fs.exists(dir))) {
        setCustomFonts([]);
        return;
      }
      const entries = await fs.readDir(dir);
      const next: CustomFontEntry[] = [];
      const styleId = 'app-font-picker-faces';
      let styleTag = document.getElementById(styleId) as HTMLStyleElement | null;
      if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = styleId;
        document.head.appendChild(styleTag);
      }
      const faceRules: string[] = [];

      for (const entry of entries) {
        if (!entry.isFile || !entry.name) continue;
        if (!/\.(ttf|otf|woff2?|woff)$/i.test(entry.name)) continue;
        const full = await pathApi.join(dir, entry.name);
        try {
          const family = await invoke<string>('read_font_family', { path: full });
          const bytes = await fs.readFile(full);
          const ext = entry.name.split('.').pop()?.toLowerCase() || 'ttf';
          const mime =
            ext === 'otf'
              ? 'font/otf'
              : ext === 'woff'
                ? 'font/woff'
                : ext === 'woff2'
                  ? 'font/woff2'
                  : 'font/ttf';
          const blob = new Blob([bytes], { type: mime });
          const blobUrl = URL.createObjectURL(blob);
          const fmt =
            ext === 'otf'
              ? 'opentype'
              : ext === 'woff'
                ? 'woff'
                : ext === 'woff2'
                  ? 'woff2'
                  : 'truetype';
          const safeFamily = family.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          faceRules.push(
            `@font-face { font-family: "${safeFamily}"; src: url("${blobUrl}") format("${fmt}"); font-display: swap; }`,
          );
          next.push({ path: full, family, blobUrl });
        } catch (e) {
          console.warn('[appFont] could not load custom font', full, e);
        }
      }

      next.sort((a, b) => a.family.localeCompare(b.family));
      styleTag.textContent = faceRules.join('\n');

      setCustomFonts((prev) => {
        for (const p of prev) URL.revokeObjectURL(p.blobUrl);
        return next;
      });
    } catch (e) {
      console.error('[appFont] reloadCustomFonts failed', e);
    }
  }, []);

  useEffect(() => {
    void reloadCustomFonts();
    return () => {
      setCustomFonts((prev) => {
        for (const p of prev) URL.revokeObjectURL(p.blobUrl);
        return [];
      });
    };
  }, [reloadCustomFonts]);

  const filteredSystem = useMemo(() => {
    const q = systemQuery.trim().toLowerCase();
    if (!q) return systemFonts;
    return systemFonts.filter((f) => f.family.toLowerCase().includes(q));
  }, [systemFonts, systemQuery]);

  const onPickDefault = () => {
    setMode('default');
  };

  const onPickSystem = (family: string) => {
    setSystemFamily(family);
    setMode('system');
    setSystemOpen(false);
  };

  const onPickCustom = (entry: CustomFontEntry) => {
    setCustom(entry.path, entry.family);
    setMode('custom');
  };

  const onAddCustom = useCallback(async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'Font', extensions: ['ttf', 'otf', 'woff', 'woff2'] }],
      });
      if (!picked || typeof picked !== 'string') return;
      const dest = await invoke<string>('copy_custom_font', { src: picked });
      const family = await invoke<string>('read_font_family', { path: dest });
      await reloadCustomFonts();
      setCustom(dest, family);
      setMode('custom');
      toast.success(t('settings.appFontCustomApplied'));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`${t('settings.appFontCustomFailed')}: ${msg}`);
    }
  }, [reloadCustomFonts, setCustom, setMode, t]);

  const onDeleteCustom = useCallback(
    async (path: string, e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        const fs = await import('@tauri-apps/plugin-fs');
        await fs.remove(path);
        if (customPath === path) {
          setCustom(null, null);
          setMode('default');
        }
        await reloadCustomFonts();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(`${t('settings.appFontCustomFailed')}: ${msg}`);
      }
    },
    [customPath, setCustom, setMode, reloadCustomFonts, t],
  );

  const onResetSize = () => setSize(APP_FONT_SIZE_DEFAULT);
  const onResetUiScale = () => setUiScale(APP_UI_SCALE_DEFAULT);

  const ModeButton = ({ id, label }: { id: AppFontMode; label: string }) => {
    const active = mode === id;
    return (
      <button
        type="button"
        onClick={() => {
          if (id === 'default') onPickDefault();
          else if (id === 'system') {
            setMode('system');
            void ensureSystemFonts();
            setSystemOpen(true);
          } else {
            setMode('custom');
          }
        }}
        className={`px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-all border cursor-pointer ${
          active
            ? 'bg-white/[0.08] border-white/[0.2] text-white/90'
            : 'bg-white/[0.02] border-white/[0.05] text-white/50 hover:bg-white/[0.05]'
        }`}
        aria-pressed={active}
      >
        {label}
      </button>
    );
  };

  return (
    <section
      className="relative bg-white/[0.02] border border-white/[0.05] backdrop-blur-[60px] rounded-3xl p-6 shadow-xl"
    >
      <h3 className="text-[15px] font-bold text-white/80 tracking-tight">
        {t('settings.appFontHeader')}
      </h3>
      <p className="text-[12px] text-white/40 mt-1 mb-4">{t('settings.appFontDesc')}</p>

      <div className="flex items-center gap-2 mb-4">
        <ModeButton id="default" label={t('settings.appFontModeDefault')} />
        <ModeButton id="system" label={t('settings.appFontModeSystem')} />
        <ModeButton id="custom" label={t('settings.appFontModeCustom')} />
      </div>

      {mode === 'default' && (
        <div className="rounded-2xl border border-white/[0.06] bg-black/20 p-4">
          <p
            className="text-[18px] text-white/85 truncate"
            style={{ fontFamily: DEFAULT_FONT_STACK }}
          >
            {FONT_PREVIEW_SAMPLE}
          </p>
          <p className="text-[11px] text-white/30 mt-2">{t('settings.appFontDefaultHint')}</p>
        </div>
      )}

      {mode === 'system' && (
        <div className="space-y-2">
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setSystemOpen((v) => !v);
                if (!systemOpen) void ensureSystemFonts();
              }}
              className="w-full flex items-center justify-between gap-3 rounded-2xl border border-white/[0.06] bg-black/20 px-4 py-3 hover:bg-black/30 transition-colors cursor-pointer"
            >
              <span
                className="text-[15px] text-white/85 truncate"
                style={{ fontFamily: systemFamily ? `"${systemFamily}", ${DEFAULT_FONT_STACK}` : DEFAULT_FONT_STACK }}
              >
                {systemFamily || t('settings.appFontSystemPlaceholder')}
              </span>
              <span className="text-white/40 text-[12px] shrink-0">
                {systemOpen ? '▲' : '▼'}
              </span>
            </button>

            {systemOpen && (
              <div className="mt-2 rounded-2xl border border-white/[0.08] bg-black/40 overflow-hidden">
                <input
                  type="text"
                  value={systemQuery}
                  onChange={(e) => setSystemQuery(e.target.value)}
                  placeholder={t('settings.appFontSystemSearch')}
                  className="w-full px-4 py-2.5 bg-transparent border-b border-white/[0.06] text-[13px] text-white/80 placeholder-white/30 focus:outline-none"
                  autoFocus
                />
                <div className="max-h-72 overflow-y-auto">
                  {systemLoading && (
                    <div className="px-4 py-3 text-[12px] text-white/40">
                      <Loader2 size={14} className="inline mr-2 animate-spin" />
                      {t('settings.appFontSystemLoading')}
                    </div>
                  )}
                  {!systemLoading && filteredSystem.length === 0 && (
                    <div className="px-4 py-3 text-[12px] text-white/40">
                      {t('settings.appFontSystemEmpty')}
                    </div>
                  )}
                  {!systemLoading &&
                    filteredSystem.slice(0, 200).map((f) => {
                      const active = systemFamily === f.family;
                      return (
                        <button
                          key={f.path}
                          type="button"
                          onClick={() => onPickSystem(f.family)}
                          className={`w-full text-left px-4 py-2 text-[15px] transition-colors cursor-pointer ${
                            active
                              ? 'bg-white/[0.06] text-white/95'
                              : 'text-white/75 hover:bg-white/[0.04]'
                          }`}
                          style={{ fontFamily: `"${f.family}", ${DEFAULT_FONT_STACK}` }}
                        >
                          {f.family}
                        </button>
                      );
                    })}
                  {!systemLoading && filteredSystem.length > 200 && (
                    <div className="px-4 py-2 text-[11px] text-white/30 border-t border-white/[0.04]">
                      {t('settings.appFontSystemMore', { count: filteredSystem.length - 200 })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {mode === 'custom' && (
        <div className="grid grid-cols-2 gap-3">
          {customFonts.map((entry) => {
            const active = customPath === entry.path;
            return (
              <div
                key={entry.path}
                className={`group relative flex flex-col gap-2 p-4 rounded-2xl border cursor-pointer transition-all ${
                  active
                    ? 'bg-white/[0.08] border-white/[0.18] ring-1 ring-accent/40'
                    : 'bg-white/[0.02] border-white/[0.05] hover:bg-white/[0.05]'
                }`}
                onClick={() => onPickCustom(entry)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onPickCustom(entry);
                  }
                }}
                aria-pressed={active}
              >
                <p
                  className="text-[18px] text-white/90 truncate"
                  style={{ fontFamily: `"${entry.family}", ${DEFAULT_FONT_STACK}` }}
                >
                  {entry.family}
                </p>
                <p
                  className="text-[12px] text-white/45 truncate"
                  style={{ fontFamily: `"${entry.family}", ${DEFAULT_FONT_STACK}` }}
                >
                  {FONT_PREVIEW_SAMPLE}
                </p>
                <button
                  type="button"
                  onClick={(e) => onDeleteCustom(entry.path, e)}
                  className="absolute top-2 right-2 w-6 h-6 rounded-full bg-black/60 text-white/70 hover:bg-red-500/80 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer"
                  aria-label={t('settings.appFontCustomDelete')}
                  title={t('settings.appFontCustomDelete')}
                >
                  <X size={12} strokeWidth={2.5} />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={onAddCustom}
            className="flex flex-col items-center justify-center gap-2 p-4 rounded-2xl border border-dashed border-white/[0.1] bg-white/[0.02] hover:bg-white/[0.05] transition-colors cursor-pointer min-h-[80px]"
          >
            <span className="text-[24px] text-white/40 leading-none font-light">+</span>
            <span className="text-[12px] text-white/50">{t('settings.appFontCustomAdd')}</span>
          </button>
          <p className="col-span-2 text-[11px] text-white/30 mt-1">
            {t('settings.appFontCustomHint')}
          </p>
        </div>
      )}

      <div className="mt-6">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[12px] text-white/55 font-medium">
            {t('settings.appFontSize')}
          </span>
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-white/80 font-semibold tabular-nums">{size}px</span>
            {size !== APP_FONT_SIZE_DEFAULT && (
              <button
                type="button"
                onClick={onResetSize}
                className="text-[11px] text-white/40 hover:text-white/70 transition-colors cursor-pointer"
              >
                {t('settings.appFontSizeReset')}
              </button>
            )}
          </div>
        </div>
        <input
          type="range"
          min={APP_FONT_SIZE_MIN}
          max={APP_FONT_SIZE_MAX}
          step={1}
          value={size}
          onChange={(e) => setSize(Number(e.target.value))}
          className="w-full accent-accent cursor-pointer"
        />
      </div>

      <div className="mt-5">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[12px] text-white/55 font-medium">
            {t('settings.appUiScale')}
          </span>
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-white/80 font-semibold tabular-nums">
              {Math.round(uiScale * 100)}%
            </span>
            {uiScale !== APP_UI_SCALE_DEFAULT && (
              <button
                type="button"
                onClick={onResetUiScale}
                className="text-[11px] text-white/40 hover:text-white/70 transition-colors cursor-pointer"
              >
                {t('settings.appFontSizeReset')}
              </button>
            )}
          </div>
        </div>
        <input
          type="range"
          min={Math.round(APP_UI_SCALE_MIN * 100)}
          max={Math.round(APP_UI_SCALE_MAX * 100)}
          step={5}
          value={Math.round(uiScale * 100)}
          onChange={(e) => setUiScale(Number(e.target.value) / 100)}
          className="w-full accent-accent cursor-pointer"
        />
        <p className="text-[11px] text-white/30 mt-1.5">
          {t('settings.appUiScaleHint')}
        </p>
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
const THEME_GRADIENT_TYPES: Array<{ id: ThemeGradientType; labelKey: string }> = [
  { id: 'linear', labelKey: 'settings.themeGradientTypeLinear' },
  { id: 'radial', labelKey: 'settings.themeGradientTypeRadial' },
];

const THEME_GRADIENT_ANIMATIONS: Array<{ id: ThemeGradientAnimation; labelKey: string }> = [
  { id: 'flow', labelKey: 'settings.themeGradientAnimationFlow' },
  { id: 'pulse', labelKey: 'settings.themeGradientAnimationPulse' },
  { id: 'breathe', labelKey: 'settings.themeGradientAnimationBreathe' },
];

const THEME_SLIDER_CLASSNAME =
  'w-full accent-[var(--color-accent)] h-1 bg-white/10 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-lg';

function ThemeOptionChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-2 rounded-xl text-[12px] font-semibold transition-all duration-200 cursor-pointer border ${
        active
          ? 'bg-white/[0.1] text-white/90 border-white/[0.15] shadow-[0_0_20px_var(--color-accent-glow)]'
          : 'bg-white/[0.03] text-white/45 border-white/[0.06] hover:bg-white/[0.06] hover:text-white/70'
      }`}
    >
      {children}
    </button>
  );
}

function ThemeColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <label className="text-[13px] text-white/50 font-medium">{label}</label>
        <span className="text-[11px] text-white/30 font-mono uppercase tracking-wide">{value}</span>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {PRESET_COLORS.map((color) => (
          <button
            key={`${label}-${color}`}
            onClick={() => onChange(color)}
            className="w-8 h-8 rounded-full border-2 transition-all duration-200 cursor-pointer hover:scale-110 active:scale-95 shadow-md"
            style={{
              backgroundColor: color,
              borderColor: value === color ? 'white' : 'transparent',
              boxShadow: value === color ? `0 0 16px ${color}60` : undefined,
            }}
          />
        ))}
        <button
          onClick={() => inputRef.current?.click()}
          className="w-8 h-8 rounded-full border-2 border-dashed border-white/20 hover:border-white/40 transition-all cursor-pointer flex items-center justify-center text-white/30 hover:text-white/60 hover:scale-110"
        >
          <span className="text-[11px] font-bold">+</span>
        </button>
        <input
          ref={inputRef}
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="sr-only"
        />
      </div>
    </div>
  );
}

const ThemeSection = React.memo(function ThemeSection() {
  const { t } = useTranslation();
  const accentColor = useSettingsStore((s) => s.accentColor);
  const bgPrimary = useSettingsStore((s) => s.bgPrimary);
  const themePreset = useSettingsStore((s) => s.themePreset);
  const themeGradientEnabled = useSettingsStore((s) => s.themeGradientEnabled);
  const themeGradientFollowArtwork = useSettingsStore((s) => s.themeGradientFollowArtwork);
  const themeGradientType = useSettingsStore((s) => s.themeGradientType);
  const themeGradientColorA = useSettingsStore((s) => s.themeGradientColorA);
  const themeGradientColorB = useSettingsStore((s) => s.themeGradientColorB);
  const themeGradientColorC = useSettingsStore((s) => s.themeGradientColorC);
  const themeGradientAngle = useSettingsStore((s) => s.themeGradientAngle);
  const themeGradientAnimated = useSettingsStore((s) => s.themeGradientAnimated);
  const themeGradientAnimation = useSettingsStore((s) => s.themeGradientAnimation);
  const themeGradientSpeed = useSettingsStore((s) => s.themeGradientSpeed);
  const themeGlowEnabled = useSettingsStore((s) => s.themeGlowEnabled);
  const themeGlowIntensity = useSettingsStore((s) => s.themeGlowIntensity);
  const themeGlowOpacity = useSettingsStore((s) => s.themeGlowOpacity);
  const backgroundImage = useSettingsStore((s) => s.backgroundImage);
  const backgroundOpacity = useSettingsStore((s) => s.backgroundOpacity);
  const setAccentColor = useSettingsStore((s) => s.setAccentColor);
  const setBgPrimary = useSettingsStore((s) => s.setBgPrimary);
  const setThemePreset = useSettingsStore((s) => s.setThemePreset);
  const setThemeGradientEnabled = useSettingsStore((s) => s.setThemeGradientEnabled);
  const setThemeGradientFollowArtwork = useSettingsStore((s) => s.setThemeGradientFollowArtwork);
  const setThemeGradientType = useSettingsStore((s) => s.setThemeGradientType);
  const setThemeGradientColorA = useSettingsStore((s) => s.setThemeGradientColorA);
  const setThemeGradientColorB = useSettingsStore((s) => s.setThemeGradientColorB);
  const setThemeGradientColorC = useSettingsStore((s) => s.setThemeGradientColorC);
  const setThemeGradientAngle = useSettingsStore((s) => s.setThemeGradientAngle);
  const setThemeGradientAnimated = useSettingsStore((s) => s.setThemeGradientAnimated);
  const setThemeGradientAnimation = useSettingsStore((s) => s.setThemeGradientAnimation);
  const setThemeGradientSpeed = useSettingsStore((s) => s.setThemeGradientSpeed);
  const setThemeGlowEnabled = useSettingsStore((s) => s.setThemeGlowEnabled);
  const setThemeGlowIntensity = useSettingsStore((s) => s.setThemeGlowIntensity);
  const setThemeGlowOpacity = useSettingsStore((s) => s.setThemeGlowOpacity);
  const setBackgroundOpacity = useSettingsStore((s) => s.setBackgroundOpacity);
  const resetTheme = useSettingsStore((s) => s.resetTheme);
  const currentArtworkUrl = usePlayerStore((s) => s.currentTrack?.artwork_url ?? null);
  const artworkGradientPalette = useArtworkGradientPalette(
    themeGradientFollowArtwork ? currentArtworkUrl : null,
  );
  const gradientFromArtworkActive =
    themeGradientEnabled && themeGradientFollowArtwork && Boolean(artworkGradientPalette);
  const effectiveAccentColor = gradientFromArtworkActive
    ? artworkGradientPalette!.gradientB
    : accentColor;
  const effectiveThemeGradientColorA = gradientFromArtworkActive
    ? artworkGradientPalette!.gradientA
    : themeGradientColorA;
  const effectiveThemeGradientColorB = gradientFromArtworkActive
    ? artworkGradientPalette!.gradientB
    : themeGradientColorB;
  const effectiveThemeGradientColorC = gradientFromArtworkActive
    ? artworkGradientPalette!.gradientC
    : themeGradientColorC;

  const previewAccentGradient = themeGradientEnabled
    ? themeGradientType === 'radial'
      ? `radial-gradient(circle at 24% 18%, ${effectiveThemeGradientColorA} 0%, ${effectiveThemeGradientColorB} 46%, ${effectiveThemeGradientColorC} 100%)`
      : `linear-gradient(${themeGradientAngle}deg, ${effectiveThemeGradientColorA} 0%, ${effectiveThemeGradientColorB} 46%, ${effectiveThemeGradientColorC} 100%)`
    : `linear-gradient(135deg, ${effectiveAccentColor} 0%, ${effectiveAccentColor} 100%)`;
  const previewGlow = themeGlowEnabled
    ? `0 0 ${Math.round(28 + themeGlowIntensity * 0.46)}px ${hexToRgba(effectiveAccentColor, 0.1 + (themeGlowOpacity / 100) * 0.22)}`
    : undefined;
  const previewGlowSurface = themeGradientEnabled
    ? themeGradientType === 'radial'
      ? `radial-gradient(circle at 24% 18%, ${hexToRgba(effectiveThemeGradientColorA, 0.34)} 0%, ${hexToRgba(effectiveThemeGradientColorB, 0.2)} 46%, ${hexToRgba(effectiveThemeGradientColorC, 0.12)} 100%)`
      : `linear-gradient(${themeGradientAngle}deg, ${hexToRgba(effectiveThemeGradientColorA, 0.32)} 0%, ${hexToRgba(effectiveThemeGradientColorB, 0.2)} 46%, ${hexToRgba(effectiveThemeGradientColorC, 0.12)} 100%)`
    : `linear-gradient(135deg, ${hexToRgba(effectiveAccentColor, 0.3)}, ${hexToRgba(effectiveAccentColor, 0.08)})`;

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
            onClick={() => setThemePreset('custom')}
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

      {themePreset === 'custom' && (
        <div className="space-y-6">
          <div
            className="relative overflow-hidden rounded-3xl border border-white/10 p-5"
            style={{
              background: bgPrimary,
            }}
          >
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.05),transparent_55%)]" />
            <div className="relative z-10 space-y-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-black/25 px-3 py-1 text-[11px] uppercase tracking-[0.16em] text-white/65">
                {t('settings.themeCustom')}
              </div>
              <div className="max-w-sm">
                <div className="text-[24px] font-bold text-white tracking-tight">
                  {t('settings.themePreview')}
                </div>
                <div className="text-[13px] text-white/70 mt-1">
                  {t('settings.themePreviewDesc')}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div
                  className="h-10 w-10 rounded-2xl border border-white/15"
                  style={{
                    background: previewAccentGradient,
                    boxShadow: previewGlow,
                  }}
                />
                <div className="flex-1 rounded-2xl border border-white/12 bg-white/8 px-4 py-3 backdrop-blur-xl">
                  <div className="text-[13px] font-semibold text-white/90">
                    {t('settings.themePreviewCard')}
                  </div>
                  <div className="text-[12px] text-white/55">
                    {t('settings.themePreviewCardDesc')}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div
                  className="h-3 flex-1 rounded-full"
                  style={{
                    background: previewAccentGradient,
                    boxShadow: previewGlow,
                    backgroundSize: themeGradientAnimated ? '180% 180%' : '100% 100%',
                  }}
                />
                <div
                  className="rounded-full px-3 py-1 text-[11px] font-semibold text-white"
                  style={{
                    background: previewAccentGradient,
                    boxShadow: previewGlow,
                    border: '1px solid rgba(255,255,255,0.12)',
                  }}
                >
                  {t('settings.themeGradient')}
                </div>
              </div>
            </div>
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <ThemeColorField
              label={t('settings.accentColor')}
              value={accentColor}
              onChange={setAccentColor}
            />
            <ThemeColorField
              label={t('settings.bgPrimary')}
              value={bgPrimary}
              onChange={setBgPrimary}
            />
          </div>

          <div className="space-y-4 rounded-3xl border border-white/[0.06] bg-white/[0.03] p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="text-[14px] font-semibold text-white/85">
                  {t('settings.themeGradient')}
                </div>
                <div className="text-[12px] text-white/45 mt-1">
                  {t('settings.themeGradientDesc')}
                </div>
              </div>
              <ThemeOptionChip
                active={themeGradientEnabled}
                onClick={() => setThemeGradientEnabled(!themeGradientEnabled)}
              >
                {themeGradientEnabled ? t('eq.on') : t('eq.off')}
              </ThemeOptionChip>
            </div>

            <div className="overflow-hidden rounded-2xl border border-white/[0.08]">
              <div
                className="h-28 w-full"
                style={{
                  background: previewAccentGradient,
                }}
              />
            </div>

            <div className="space-y-3">
              <label className="text-[13px] text-white/50 font-medium">
                {t('settings.themeGradientType')}
              </label>
              <div className="flex flex-wrap gap-2">
                {THEME_GRADIENT_TYPES.map((option) => (
                  <ThemeOptionChip
                    key={option.id}
                    active={themeGradientType === option.id}
                    onClick={() => setThemeGradientType(option.id)}
                  >
                    {t(option.labelKey)}
                  </ThemeOptionChip>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-start justify-between gap-4 rounded-2xl border border-white/[0.05] bg-black/10 px-4 py-3">
              <div>
                <div className="text-[13px] font-semibold text-white/80">
                  {t('settings.themeGradientFollowArtwork')}
                </div>
                <div className="mt-1 text-[11px] text-white/40">
                  {t('settings.themeGradientFollowArtworkDesc')}
                </div>
              </div>
              <ThemeOptionChip
                active={themeGradientFollowArtwork}
                onClick={() => setThemeGradientFollowArtwork(!themeGradientFollowArtwork)}
              >
                {themeGradientFollowArtwork ? t('eq.on') : t('eq.off')}
              </ThemeOptionChip>
            </div>

            {themeGradientFollowArtwork && (
              <div className="text-[11px] text-white/32">
                {t('settings.themeGradientFollowArtworkHint')}
              </div>
            )}

            <div
              className={`grid gap-5 xl:grid-cols-3 transition-opacity ${
                themeGradientFollowArtwork ? 'opacity-55' : ''
              }`}
            >
              <ThemeColorField
                label={t('settings.themeGradientColorA')}
                value={themeGradientColorA}
                onChange={setThemeGradientColorA}
              />
              <ThemeColorField
                label={t('settings.themeGradientColorB')}
                value={themeGradientColorB}
                onChange={setThemeGradientColorB}
              />
              <ThemeColorField
                label={t('settings.themeGradientColorC')}
                value={themeGradientColorC}
                onChange={setThemeGradientColorC}
              />
            </div>

            {themeGradientType === 'linear' && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-[13px] text-white/50 font-medium">
                    {t('settings.themeGradientAngle')}
                  </label>
                  <span className="text-[12px] text-white/30 tabular-nums">
                    {themeGradientAngle}deg
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={360}
                  step={1}
                  value={themeGradientAngle}
                  onChange={(e) => setThemeGradientAngle(Number(e.target.value))}
                  className={THEME_SLIDER_CLASSNAME}
                />
              </div>
            )}

            <div className="space-y-4 rounded-2xl border border-white/[0.05] bg-black/10 p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="text-[13px] font-semibold text-white/82">
                    {t('settings.themeGradientAnimated')}
                  </div>
                  <div className="text-[12px] text-white/42 mt-1">
                    {t('settings.themeGradientAnimatedDesc')}
                  </div>
                </div>
                <ThemeOptionChip
                  active={themeGradientAnimated}
                  onClick={() => setThemeGradientAnimated(!themeGradientAnimated)}
                >
                  {themeGradientAnimated ? t('eq.on') : t('eq.off')}
                </ThemeOptionChip>
              </div>

              <div className="space-y-3">
                <label className="text-[13px] text-white/50 font-medium">
                  {t('settings.themeGradientAnimation')}
                </label>
                <div className="flex flex-wrap gap-2">
                  {THEME_GRADIENT_ANIMATIONS.map((option) => (
                    <ThemeOptionChip
                      key={option.id}
                      active={themeGradientAnimation === option.id}
                      onClick={() => setThemeGradientAnimation(option.id)}
                    >
                      {t(option.labelKey)}
                    </ThemeOptionChip>
                  ))}
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-[13px] text-white/50 font-medium">
                    {t('settings.themeGradientSpeed')}
                  </label>
                  <span className="text-[12px] text-white/30 tabular-nums">
                    {themeGradientSpeed}s
                  </span>
                </div>
                <input
                  type="range"
                  min={6}
                  max={30}
                  step={1}
                  value={themeGradientSpeed}
                  onChange={(e) => setThemeGradientSpeed(Number(e.target.value))}
                  className={THEME_SLIDER_CLASSNAME}
                />
              </div>
            </div>
          </div>

          <div className="space-y-4 rounded-3xl border border-white/[0.06] bg-white/[0.03] p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="text-[14px] font-semibold text-white/85">
                  {t('settings.themeGlow')}
                </div>
                <div className="text-[12px] text-white/45 mt-1">{t('settings.themeGlowDesc')}</div>
              </div>
              <ThemeOptionChip
                active={themeGlowEnabled}
                onClick={() => setThemeGlowEnabled(!themeGlowEnabled)}
              >
                {themeGlowEnabled ? t('eq.on') : t('eq.off')}
              </ThemeOptionChip>
            </div>

            <div className="rounded-2xl border border-white/[0.08] bg-black/18 p-5">
              <div
                className="mx-auto h-14 max-w-[280px] rounded-2xl border border-white/10"
                style={{
                  background: previewGlowSurface,
                  boxShadow: previewGlow,
                  backgroundSize: themeGradientAnimated ? '180% 180%' : '100% 100%',
                }}
              />
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-[13px] text-white/50 font-medium">
                  {t('settings.themeGlowIntensity')}
                </label>
                <span className="text-[12px] text-white/30 tabular-nums">
                  {themeGlowIntensity}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={themeGlowIntensity}
                onChange={(e) => setThemeGlowIntensity(Number(e.target.value))}
                className={THEME_SLIDER_CLASSNAME}
              />
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-[13px] text-white/50 font-medium">
                  {t('settings.themeGlowOpacity')}
                </label>
                <span className="text-[12px] text-white/30 tabular-nums">{themeGlowOpacity}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={themeGlowOpacity}
                onChange={(e) => setThemeGlowOpacity(Number(e.target.value))}
                className={THEME_SLIDER_CLASSNAME}
              />
            </div>
          </div>
        </div>
      )}

      <WallpaperPicker />

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
            className={THEME_SLIDER_CLASSNAME}
          />
        </div>
      )}
    </section>
  );
});

/* ── Audio Device Section ──────────────────────────────── */

interface AudioSink {
  name: string;
  display_name: string;
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
      const primary = (sink.display_name || sink.description || sink.name || '').trim();
      const secondary = (sink.description || '').trim();
      const base =
        primary && secondary && secondary !== primary ? `${primary} - ${secondary}` : primary;
      const normalizedBase = base || t('settings.audioDeviceDefault');
      totalByLabel.set(normalizedBase, (totalByLabel.get(normalizedBase) || 0) + 1);
    }

    const seenByLabel = new Map<string, number>();
    return sinks.map((sink) => {
      const primary = (sink.display_name || sink.description || sink.name || '').trim();
      const secondary = (sink.description || '').trim();
      const base =
        primary && secondary && secondary !== primary ? `${primary} - ${secondary}` : primary;
      const normalizedBase = base || t('settings.audioDeviceDefault');
      const seen = (seenByLabel.get(normalizedBase) || 0) + 1;
      seenByLabel.set(normalizedBase, seen);

      const total = totalByLabel.get(normalizedBase) || 1;
      const label = total > 1 ? `${normalizedBase} (${seen})` : normalizedBase;
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

/* ── Playback Section ─────────────────────────────────── */

const PlaybackSection = React.memo(function PlaybackSection() {
  const { t } = useTranslation();
  const { data: isPremium } = useSubscription(true);
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
  const experimentalRuAudioTextWarmup = useSettingsStore((s) => s.experimentalRuAudioTextWarmup);
  const setTargetFramerate = useSettingsStore((s) => s.setTargetFramerate);
  const setUnlockFramerate = useSettingsStore((s) => s.setUnlockFramerate);
  const setShowFpsCounter = useSettingsStore((s) => s.setShowFpsCounter);
  const setHardwareAcceleration = useSettingsStore((s) => s.setHardwareAcceleration);
  const setLowPerformanceMode = useSettingsStore((s) => s.setLowPerformanceMode);
  const setExperimentalRuAudioTextWarmup = useSettingsStore(
    (s) => s.setExperimentalRuAudioTextWarmup,
  );
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
          <p className="text-[13px] text-white/70 font-medium">
            {t('settings.normalizeVolume', 'Normalize Volume')}
          </p>
          <p className="text-[11px] text-white/30 mt-0.5">
            {t('settings.normalizeVolumeDesc', 'Level loudness between tracks')}
          </p>
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

      {isPremium && (
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[13px] text-white/70 font-medium">
            {t('settings.highQualityStreaming')}
          </p>
          <p className="text-[11px] text-white/30 mt-0.5">
            {t('settings.highQualityStreamingDesc')}
          </p>
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
      )}

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

        <div
          className={`transition-opacity duration-300 space-y-3 ${crossfadeEnabled ? 'opacity-100' : 'opacity-30 pointer-events-none'}`}
        >
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

      <div className="flex items-center justify-between">
        <div className="space-y-1 pr-4">
          <p className="text-[13px] text-white/70 font-medium">
            {t(
              'settings.experimentalRuAudioTextWarmup',
              'Экспериментально: Light Audio-Text Warmup (RU)',
            )}
          </p>
          <p className="text-[11px] text-white/30">
            {t(
              'settings.experimentalRuAudioTextWarmupDesc',
              'Экспериментальный лёгкий warmup, который слегка подготавливает тайминг сгенерированной русской лирики. По умолчанию выключен.',
            )}
          </p>
        </div>
        <button
          onClick={() => setExperimentalRuAudioTextWarmup(!experimentalRuAudioTextWarmup)}
          className={`w-11 h-6 rounded-full transition-all duration-200 cursor-pointer relative ${
            experimentalRuAudioTextWarmup ? 'bg-accent' : 'bg-white/10'
          }`}
        >
          <div
            className={`absolute top-0.5 w-5 h-5 rounded-full shadow-md transition-all duration-200 ${
              experimentalRuAudioTextWarmup ? 'left-[22px] bg-accent-contrast' : 'left-0.5 bg-white'
            }`}
          />
        </button>
      </div>

      <div className="border-t border-white/[0.04]" />

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[13px] text-white/70 font-medium">
              {t('settings.discordRpc', 'Discord Rich Presence')}
            </p>
            <p className="text-[11px] text-white/30 mt-0.5">
              {t('settings.discordRpcDesc', 'Show what you are listening to in Discord')}
            </p>
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
              <p className="text-[13px] text-white/50 font-medium">
                {t('settings.discordRpcMode', 'Display Mode')}
              </p>
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
          <p className="text-[11px] text-white/30">{t('settings.lowPerformanceModeDesc')}</p>
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

const QrLinkSheetLazy = React.lazy(() =>
  import('../components/auth/QrLinkSheet').then((m) => ({ default: m.QrLinkSheet })),
);

/* ── Account Section ────────────────────────────────────── */

const AccountSection = React.memo(function AccountSection() {
  const { t } = useTranslation();
  const logout = useAuthStore((s) => s.logout);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [transferOpen, setTransferOpen] = useState(false);

  return (
    <section className="bg-white/[0.02] border border-white/[0.05] backdrop-blur-[60px] rounded-3xl p-6 shadow-xl">
      <h3 className="text-[15px] font-bold text-white/80 tracking-tight mb-5">
        {t('settings.account')}
      </h3>
      <div className="flex flex-wrap gap-2">
        {isAuthenticated && (
          <button
            type="button"
            onClick={() => setTransferOpen(true)}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-[13px] font-semibold bg-white/[0.04] text-white/70 hover:bg-white/[0.08] hover:text-white/90 border border-white/[0.06] transition-all duration-300 cursor-pointer"
          >
            <Smartphone size={14} />
            {t('qrLink.transferSession')}
          </button>
        )}
        <button
          onClick={logout}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-[13px] font-semibold bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/10 hover:border-red-500/20 transition-all duration-300 cursor-pointer"
        >
          {t('auth.signOut')}
        </button>
      </div>
      {transferOpen && (
        <React.Suspense fallback={null}>
          <QrLinkSheetLazy open={transferOpen} onOpenChange={setTransferOpen} mode="push" />
        </React.Suspense>
      )}
    </section>
  );
});

/* ── Visualizer Section ──────────────────────────────────── */

const VisualizerSection = React.memo(function VisualizerSection() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  // All hooks must be called unconditionally (Rules of Hooks)
  const style = useSettingsStore((s) => s.visualizerStyle);
  const playbar = useSettingsStore((s) => s.visualizerPlaybar);
  const fullscreen = useSettingsStore((s) => s.visualizerFullscreen);
  const themeColor = useSettingsStore((s) => s.visualizerThemeColor);
  const mirror = useSettingsStore((s) => s.visualizerMirror);
  const height = useSettingsStore((s) => s.visualizerHeight);
  const scale = useSettingsStore((s) => s.visualizerScale);
  const opacity = useSettingsStore((s) => s.visualizerOpacity);
  const smoothing = useSettingsStore((s) => s.visualizerSmoothing);
  const fade = useSettingsStore((s) => s.visualizerFade);
  const bars = useSettingsStore((s) => s.visualizerBars);
  const yOffset = useSettingsStore((s) => s.visualizerYOffset);
  const isOff = style === 'Off';

  return (
    <section className="bg-white/[0.02] border border-white/[0.05] backdrop-blur-[60px] rounded-3xl shadow-xl overflow-hidden mt-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-6 py-5 hover:bg-white/[0.02] transition-colors cursor-pointer"
      >
        <h3 className="text-[15px] font-bold text-white/80 tracking-tight">
          {t('visualizer.title', 'Audio Visualizer')}
        </h3>
        <div className="flex items-center gap-3">
          <span
            className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${!isOff ? 'bg-emerald-500/15 text-emerald-400' : 'bg-white/[0.05] text-white/30'}`}
          >
            {!isOff ? t('eq.on', 'On') : t('eq.off', 'Off')}
          </span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            className={`text-white/30 transition-transform duration-300 ${open ? 'rotate-180' : ''}`}
          >
            <path
              d="M3 5l4 4 4-4"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </button>

      {open && (
        <div className="px-6 pb-6 space-y-4 border-t border-white/[0.05] pt-4 animate-fade-in-up">
          <div className="flex gap-2 bg-white/[0.04] p-1 rounded-xl">
            {['Off', 'Bars', 'Wave', 'Pulse'].map((s) => {
              const isActive = style === s;
              const label =
                s === 'Off'
                  ? t('visualizer.off', 'Off')
                  : s === 'Bars'
                    ? t('visualizer.bars', 'Bars')
                    : s === 'Wave'
                      ? t('visualizer.wave', 'Wave')
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

          <div
            className={`space-y-4 transition-opacity duration-300 ${isOff ? 'opacity-30 pointer-events-none' : 'opacity-100'}`}
          >
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-white/60">
                {t('visualizer.showAbovePlaybar', 'Show above playbar')}
              </span>
              <input
                type="checkbox"
                checked={playbar}
                onChange={(e) => useSettingsStore.getState().setVisualizerPlaybar(e.target.checked)}
                className="w-4 h-4 accent-[var(--color-accent)] cursor-pointer"
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-white/60">
                {t('visualizer.showInFullscreen', 'Show in Fullscreen')}
              </span>
              <input
                type="checkbox"
                checked={fullscreen}
                onChange={(e) =>
                  useSettingsStore.getState().setVisualizerFullscreen(e.target.checked)
                }
                className="w-4 h-4 accent-[var(--color-accent)] cursor-pointer"
              />
            </div>
            <div className="flex items-center justify-between pt-1">
              <span className="text-[13px] text-white/60">
                {t('visualizer.useThemeColor', 'Use Theme Color')}
              </span>
              <input
                type="checkbox"
                checked={themeColor}
                onChange={(e) =>
                  useSettingsStore.getState().setVisualizerThemeColor(e.target.checked)
                }
                className="w-4 h-4 accent-[var(--color-accent)] cursor-pointer"
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-white/60">
                {t('visualizer.mirror', 'Mirror (flip horizontally)')}
              </span>
              <input
                type="checkbox"
                checked={mirror}
                onChange={(e) => useSettingsStore.getState().setVisualizerMirror(e.target.checked)}
                className="w-4 h-4 accent-[var(--color-accent)] cursor-pointer"
              />
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[13px] text-white/60">
                  {t('visualizer.height', 'Height')}
                </label>
                <span className="text-[12px] text-white/40 tabular-nums">{height}px</span>
              </div>
              <input
                type="range"
                min={32}
                max={300}
                step={8}
                value={height}
                onChange={(e) =>
                  useSettingsStore.getState().setVisualizerHeight(Number(e.target.value))
                }
                className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-[var(--color-accent)]"
              />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[13px] text-white/60">
                  {t('visualizer.scale', 'Scale')}
                </label>
                <span className="text-[12px] text-white/40 tabular-nums">{scale}%</span>
              </div>
              <input
                type="range"
                min={50}
                max={200}
                step={10}
                value={scale}
                onChange={(e) =>
                  useSettingsStore.getState().setVisualizerScale(Number(e.target.value))
                }
                className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-[var(--color-accent)]"
              />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[13px] text-white/60">
                  {t('visualizer.opacity', 'Opacity')}
                </label>
                <span className="text-[12px] text-white/40 tabular-nums">{opacity}%</span>
              </div>
              <input
                type="range"
                min={10}
                max={100}
                step={5}
                value={opacity}
                onChange={(e) =>
                  useSettingsStore.getState().setVisualizerOpacity(Number(e.target.value))
                }
                className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-[var(--color-accent)]"
              />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[13px] text-white/60">
                  {t('visualizer.smoothing', 'Smoothing')}
                </label>
                <span className="text-[12px] text-white/40 tabular-nums">{smoothing}%</span>
              </div>
              <input
                type="range"
                min={5}
                max={80}
                step={5}
                value={smoothing}
                onChange={(e) =>
                  useSettingsStore.getState().setVisualizerSmoothing(Number(e.target.value))
                }
                className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-[var(--color-accent)]"
              />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[13px] text-white/60">{t('visualizer.fade', 'Fade')}</label>
                <span className="text-[12px] text-white/40 tabular-nums">{fade}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={fade}
                onChange={(e) =>
                  useSettingsStore.getState().setVisualizerFade(Number(e.target.value))
                }
                className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-[var(--color-accent)]"
              />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[13px] text-white/60">
                  {t('visualizer.barCount', 'Bar Count')}
                </label>
                <span className="text-[12px] text-white/40 tabular-nums">{bars}</span>
              </div>
              <input
                type="range"
                min={8}
                max={128}
                step={4}
                value={bars}
                onChange={(e) =>
                  useSettingsStore.getState().setVisualizerBars(Number(e.target.value))
                }
                className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-[var(--color-accent)]"
              />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[13px] text-white/60">
                  {t('visualizer.yOffset', 'Y-Offset')}
                </label>
                <span className="text-[12px] text-white/40 tabular-nums">{yOffset}px</span>
              </div>
              <input
                type="range"
                min={-300}
                max={300}
                step={10}
                value={yOffset}
                onChange={(e) =>
                  useSettingsStore.getState().setVisualizerYOffset(Number(e.target.value))
                }
                className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-[var(--color-accent)]"
              />
            </div>
          </div>
        </div>
      )}
    </section>
  );
});

/* ── Equalizer Section ───────────────────────────────────── */

const EQ_BANDS_LABELS = [
  '30Hz',
  '60Hz',
  '125Hz',
  '250Hz',
  '500Hz',
  '1kHz',
  '2kHz',
  '4kHz',
  '8kHz',
  '14kHz',
];

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
        <h3 className="text-[15px] font-bold text-white/80 tracking-tight">
          {t('eq.title', 'Equalizer')}
        </h3>
        <div className="flex items-center gap-3">
          {/* EQ enabled badge */}
          <span
            className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${eqEnabled ? 'bg-emerald-500/15 text-emerald-400' : 'bg-white/[0.05] text-white/30'}`}
          >
            {eqEnabled ? t('eq.on', 'On') : t('eq.off', 'Off')}
          </span>
          {/* Chevron */}
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            className={`text-white/30 transition-transform duration-300 ${open ? 'rotate-180' : ''}`}
          >
            <path
              d="M3 5l4 4 4-4"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </button>

      {/* Collapsible Body */}
      {open && (
        <div className="px-6 pb-6 space-y-4 border-t border-white/[0.05] pt-4 animate-fade-in-up">
          {/* Enable toggle */}
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-white/60">
              {t('eq.enableEqualizer', 'Enable Equalizer')}
            </span>
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

          <div
            className={`transition-opacity duration-300 ${eqEnabled ? 'opacity-100' : 'opacity-30 pointer-events-none'}`}
          >
            <div className="flex items-end justify-between h-48 pt-2 pb-2 gap-1 overflow-x-auto relative">
              {eqGains.map((gain, i) => (
                <div
                  key={i}
                  className="flex flex-col items-center justify-end h-full gap-3 flex-1 min-w-[28px]"
                >
                  <span className="text-[10px] text-white/40 font-medium tabular-nums">
                    {gain > 0 ? `+${gain.toFixed(1)}` : gain.toFixed(1)}
                  </span>
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
                  <span className="text-[10px] text-white/50 font-semibold">
                    {EQ_BANDS_LABELS[i]}
                  </span>
                </div>
              ))}
            </div>

            <div className="flex justify-end pt-4 border-t border-white/[0.05] mt-2">
              <button
                onClick={() => setEqGains([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])}
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
        <h3 className="text-[15px] font-bold text-white/80 tracking-tight">
          {t('settings.apiServer')}
        </h3>
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
      <AppIconSection />
      <AppFontSection />
      <CacheSection />
      <ThemeSection />
      <VisualizerSection />
      <PlaybackSection />
      <EqualizerSection />
      <AudioDeviceSection />
      <ImportSection />
      <ApiSection />

      <AccountSection />
    </div>
  );
}
