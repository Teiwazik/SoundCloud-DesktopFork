import {
  Car,
  Check,
  ChevronDown,
  Dumbbell,
  Frown,
  Globe,
  Heart,
  Laptop,
  Loader2,
  Moon,
  Music,
  RefreshCw,
  Sparkles,
  Sun,
  Waves,
  X,
  Zap,
} from 'lucide-react';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Pause, Play, Settings } from '../../lib/icons';
import { SUPPORTED_LANGUAGES } from '../../lib/language-detection';
import { usePlayerStore } from '../../stores/player';
import { useSettingsStore } from '../../stores/settings';
import {
  ACTIVITY_PRESETS,
  CHARACTER_PRESETS,
  MOOD_PRESETS,
  type SoundWavePreset,
  useSoundWaveStore,
} from '../../stores/soundwave';

const SOUNDWAVE_PRESET_MAP = {
  ...ACTIVITY_PRESETS,
  ...MOOD_PRESETS,
  ...CHARACTER_PRESETS,
};

const LANGUAGE_FLAG_COUNTRY: Record<string, string> = {
  en: 'gb',
  ru: 'ru',
  uk: 'ua',
  kk: 'kz',
  de: 'de',
  fr: 'fr',
  es: 'es',
  pt: 'br',
  it: 'it',
  pl: 'pl',
  ja: 'jp',
  ko: 'kr',
  zh: 'cn',
  tr: 'tr',
  ar: 'sa',
  hi: 'in',
};

const getLanguageFlagUrl = (code: string): string | null => {
  const countryCode = LANGUAGE_FLAG_COUNTRY[code];
  if (!countryCode) return null;
  return `https://flagcdn.com/w40/${countryCode}.png`;
};

const SOUNDWAVE_GENRE_OPTIONS = [
  { value: 'hip hop', labelKey: 'settings.genreHipHop' },
  { value: 'rap', labelKey: 'settings.genreRap' },
  { value: 'pop', labelKey: 'settings.genrePop' },
  { value: 'rock', labelKey: 'settings.genreRock' },
  { value: 'indie', labelKey: 'settings.genreIndie' },
  { value: 'electronic', labelKey: 'settings.genreElectronic' },
  { value: 'house', labelKey: 'settings.genreHouse' },
  { value: 'techno', labelKey: 'settings.genreTechno' },
  { value: 'trance', labelKey: 'settings.genreTrance' },
  { value: 'drum and bass', labelKey: 'settings.genreDnB' },
  { value: 'dubstep', labelKey: 'settings.genreDubstep' },
  { value: 'phonk', labelKey: 'settings.genrePhonk' },
  { value: 'rnb', labelKey: 'settings.genreRnb' },
  { value: 'jazz', labelKey: 'settings.genreJazz' },
  { value: 'ambient', labelKey: 'settings.genreAmbient' },
  { value: 'lofi', labelKey: 'settings.genreLofi' },
  { value: 'classical', labelKey: 'settings.genreClassical' },
] as const;

type SoundWavePresetKey =
  | 'wakeup'
  | 'commute'
  | 'work'
  | 'workout'
  | 'sleep'
  | 'energetic'
  | 'happy'
  | 'calm'
  | 'sad'
  | 'favorite'
  | 'discover'
  | 'popular';

const getPresetByKey = (key: string): SoundWavePreset => {
  const preset = SOUNDWAVE_PRESET_MAP[key as SoundWavePresetKey];
  return preset || ACTIVITY_PRESETS.work;
};

interface Blob {
  x: number;
  y: number;
  vx: number;
  vy: number;
  baseR: number;
  r: number;
  color: number[];
  phase: number;
  wobble: number;
  wobbleSpd: number;
  angleOffset: number;
}

export const SoundWaveHero: React.FC = () => {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isPrefetchingRef = useRef(false);
  const awaitingFirstPlayableRef = useRef(false);
  const genreMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const languageMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [isGenreMenuOpen, setIsGenreMenuOpen] = useState(false);
  const [genreMenuPosition, setGenreMenuPosition] = useState<{ top: number; left: number } | null>(
    null,
  );
  const [isLanguageMenuOpen, setIsLanguageMenuOpen] = useState(false);
  const [languageMenuPosition, setLanguageMenuPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [isAwaitingFirstTrack, setIsAwaitingFirstTrack] = useState(false);
  const [showRestartAfterLanguageChange, setShowRestartAfterLanguageChange] = useState(false);

  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const pausePlayback = usePlayerStore((s) => s.pause);
  const queue = usePlayerStore((s) => s.queue);
  const queueIndex = usePlayerStore((s) => s.queueIndex);
  const queueLength = usePlayerStore((s) => s.queue.length);
  const addToQueue = usePlayerStore((s) => s.addToQueue);

  const isActive = useSoundWaveStore((s) => s.isActive);
  const isSuspended = useSoundWaveStore((s) => s.isSuspended);
  const currentPreset = useSoundWaveStore((s) => s.currentPreset);
  const startWave = useSoundWaveStore((s) => s.start);
  const stopWave = useSoundWaveStore((s) => s.stop);
  const resumeSuspendedPlayback = useSoundWaveStore((s) => s.resumeSuspendedPlayback);
  const suspendForExternalPlayback = useSoundWaveStore((s) => s.suspendForExternalPlayback);
  const generateBatch = useSoundWaveStore((s) => s.generateBatch);
  const isInitialLoading = useSoundWaveStore((s) => s.isInitialLoading);
  const startupProgress = useSoundWaveStore((s) => s.startupProgress);
  const startupVisible = useSoundWaveStore((s) => s.startupVisible);
  const startupStage = useSoundWaveStore((s) => s.startupStage);
  const selectedPresetKey = useSettingsStore((s) => s.soundwavePresetKey);
  const setSoundwavePresetKey = useSettingsStore((s) => s.setSoundwavePresetKey);
  const languageFilterEnabled = useSettingsStore((s) => s.languageFilterEnabled);
  const preferredLanguage = useSettingsStore((s) => s.preferredLanguage);
  const setLanguageFilterEnabled = useSettingsStore((s) => s.setLanguageFilterEnabled);
  const setPreferredLanguage = useSettingsStore((s) => s.setPreferredLanguage);
  const soundwaveGenreStrict = useSettingsStore((s) => s.soundwaveGenreStrict);
  const soundwaveSelectedGenres = useSettingsStore((s) => s.soundwaveSelectedGenres);
  const soundwaveHideLiked = useSettingsStore((s) => s.soundwaveHideLiked);
  const soundwaveTrackVisual = useSettingsStore((s) => s.soundwaveTrackVisual);
  const setSoundwaveGenreStrict = useSettingsStore((s) => s.setSoundwaveGenreStrict);
  const setSoundwaveSelectedGenres = useSettingsStore((s) => s.setSoundwaveSelectedGenres);
  const setSoundwaveHideLiked = useSettingsStore((s) => s.setSoundwaveHideLiked);
  const setSoundwaveTrackVisual = useSettingsStore((s) => s.setSoundwaveTrackVisual);
  const selectedPreset = getPresetByKey(selectedPresetKey);

  // Prefetching logic
  useEffect(() => {
    if (!isActive) return;
    if (isSuspended) return;
    if (isInitialLoading) return;
    if (queueIndex < 0 || queueLength === 0) return;

    // If we have less than 5 tracks left in queue, fetch more
    const remaining = queueLength - (queueIndex + 1);
    if (remaining < 5) {
      if (isPrefetchingRef.current) return;
      isPrefetchingRef.current = true;
      console.log('[SoundWave] Queue low, prefetching...');
      generateBatch()
        .then((newTracks) => {
          if (newTracks.length > 0) {
            addToQueue(newTracks);
          }
        })
        .finally(() => {
          isPrefetchingRef.current = false;
        });
    }
  }, [isActive, isSuspended, queueIndex, queueLength, generateBatch, addToQueue, isInitialLoading]);

  useEffect(() => {
    if (!isAwaitingFirstTrack) return;

    if (!isActive) {
      setIsAwaitingFirstTrack(false);
      awaitingFirstPlayableRef.current = false;
      return;
    }

    if (!currentTrack || !currentTrack.streamQuality) {
      awaitingFirstPlayableRef.current = true;
      return;
    }

    if (awaitingFirstPlayableRef.current) {
      setIsAwaitingFirstTrack(false);
      awaitingFirstPlayableRef.current = false;
    }
  }, [isAwaitingFirstTrack, isActive, currentTrack?.urn, currentTrack?.streamQuality]);

  useEffect(() => {
    if (isActive) return;
    setShowRestartAfterLanguageChange(false);
  }, [isActive]);

  useEffect(() => {
    if (!isGenreMenuOpen) {
      setGenreMenuPosition(null);
      return;
    }

    const updateGenreMenuPosition = () => {
      const trigger = genreMenuButtonRef.current;
      if (!trigger) return;

      const rect = trigger.getBoundingClientRect();
      const menuWidth = 232;
      const menuHeight = 336;
      const viewportPadding = 12;

      const left = Math.min(
        Math.max(viewportPadding, rect.right - menuWidth),
        window.innerWidth - menuWidth - viewportPadding,
      );
      const top =
        rect.top - menuHeight - 8 > viewportPadding
          ? rect.top - menuHeight - 8
          : Math.min(window.innerHeight - menuHeight - viewportPadding, rect.bottom + 8);

      setGenreMenuPosition({ top, left });
    };

    updateGenreMenuPosition();

    window.addEventListener('resize', updateGenreMenuPosition);
    window.addEventListener('scroll', updateGenreMenuPosition, true);

    return () => {
      window.removeEventListener('resize', updateGenreMenuPosition);
      window.removeEventListener('scroll', updateGenreMenuPosition, true);
    };
  }, [isGenreMenuOpen]);

  useEffect(() => {
    if (!isLanguageMenuOpen) {
      setLanguageMenuPosition(null);
      return;
    }

    const updateLanguageMenuPosition = () => {
      const trigger = languageMenuButtonRef.current;
      if (!trigger) return;

      const rect = trigger.getBoundingClientRect();
      const menuWidth = 176;
      const menuHeight = 270;
      const viewportPadding = 12;

      const left = Math.min(
        Math.max(viewportPadding, rect.right - menuWidth),
        window.innerWidth - menuWidth - viewportPadding,
      );
      const top =
        rect.top - menuHeight - 8 > viewportPadding
          ? rect.top - menuHeight - 8
          : Math.min(window.innerHeight - menuHeight - viewportPadding, rect.bottom + 8);

      setLanguageMenuPosition({ top, left });
    };

    updateLanguageMenuPosition();

    window.addEventListener('resize', updateLanguageMenuPosition);
    window.addEventListener('scroll', updateLanguageMenuPosition, true);

    return () => {
      window.removeEventListener('resize', updateLanguageMenuPosition);
      window.removeEventListener('scroll', updateLanguageMenuPosition, true);
    };
  }, [isLanguageMenuOpen]);

  // Animation logic — reactive to audio
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let lastFrameTime = 0;
    let unlistenAudio: (() => void) | null = null;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const blobs: Blob[] = [];
    const blobCount = reducedMotion ? 3 : 5;

    // Smoothed audio energy bands
    const energy = { bass: 0, mid: 0, high: 0, overall: 0 };
    const targetEnergy = { bass: 0, mid: 0, high: 0, overall: 0 };

    // Subscribe to audio visualizer data from Tauri
    const setupAudio = async () => {
      try {
        const fn = await listen<number[]>('audio:visualizer', (ev) => {
          const d = ev.payload;
          if (!d || d.length === 0) return;
          const len = d.length;
          // Bass: bins 0-3, Mid: bins 4-15, High: bins 16+
          let bass = 0, mid = 0, high = 0;
          for (let i = 0; i < Math.min(4, len); i++) bass += d[i];
          bass /= Math.min(4, len);
          for (let i = 4; i < Math.min(16, len); i++) mid += d[i];
          mid /= Math.min(12, len - 4);
          for (let i = 16; i < len; i++) high += d[i];
          high /= Math.max(1, len - 16);
          targetEnergy.bass = bass / 255;
          targetEnergy.mid = mid / 255;
          targetEnergy.high = high / 255;
          targetEnergy.overall = (bass * 0.5 + mid * 0.35 + high * 0.15) / 255;
        });
        unlistenAudio = fn;
      } catch { /* noop */ }
    };
    setupAudio();

    const resize = () => {
      const w = canvas.offsetWidth;
      const h = canvas.offsetHeight;
      if (w === 0 || h === 0) return;
      const dpr = window.devicePixelRatio;
      const newW = Math.round(w * dpr);
      const newH = Math.round(h * dpr);
      if (canvas.width === newW && canvas.height === newH) return;
      canvas.width = newW;
      canvas.height = newH;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    // Default warm palette
    const defaultColors = [
      [255, 85, 0],   // SoundCloud Orange
      [255, 45, 85],  // Pink
      [191, 90, 242], // Purple
      [94, 92, 230],  // Blue
      [255, 159, 10], // Amber
    ];

    const w0 = canvas.offsetWidth || 400;
    const h0 = canvas.offsetHeight || 220;
    const cx = w0 / 2;
    const cy = h0 / 2;

    for (let i = 0; i < blobCount; i++) {
      const angle = (i / blobCount) * Math.PI * 2;
      const dist = 30 + Math.random() * 40;
      blobs.push({
        x: cx + Math.cos(angle) * dist,
        y: cy + Math.sin(angle) * dist,
        vx: (Math.random() - 0.5) * 0.6,
        vy: (Math.random() - 0.5) * 0.6,
        baseR: 70 + Math.random() * 80,
        r: 70 + Math.random() * 80,
        color: defaultColors[i % defaultColors.length],
        phase: (i / blobCount) * Math.PI * 2,
        wobble: 0,
        wobbleSpd: 0.015 + Math.random() * 0.025,
        angleOffset: angle,
      });
    }

    const draw = (ts: number) => {
      const w = canvas.offsetWidth;
      const h = canvas.offsetHeight;
      if (w === 0 || h === 0) {
        animationFrameId = requestAnimationFrame(draw);
        return;
      }

      if (document.visibilityState === 'hidden') {
        animationFrameId = requestAnimationFrame(draw);
        return;
      }

      const isActuallyPlaying = isPlaying && isActive;
      const targetFps = reducedMotion ? 8 : isActuallyPlaying ? 30 : 4;
      const frameInterval = 1000 / targetFps;
      if (ts - lastFrameTime < frameInterval) {
        animationFrameId = requestAnimationFrame(draw);
        return;
      }
      lastFrameTime = ts;

      // Smooth energy towards target
      const lerpRate = 0.18;
      energy.bass += (targetEnergy.bass - energy.bass) * lerpRate;
      energy.mid += (targetEnergy.mid - energy.mid) * lerpRate;
      energy.high += (targetEnergy.high - energy.high) * lerpRate;
      energy.overall += (targetEnergy.overall - energy.overall) * lerpRate;

      // Decay target when not playing
      if (!isActuallyPlaying) {
        targetEnergy.bass *= 0.92;
        targetEnergy.mid *= 0.92;
        targetEnergy.high *= 0.92;
        targetEnergy.overall *= 0.92;
      }

      ctx.clearRect(0, 0, w, h);
      ctx.filter = reducedMotion ? 'blur(28px)' : 'blur(44px)';
      ctx.globalCompositeOperation = 'screen';

      const speedMult = isActuallyPlaying ? 1.2 + energy.overall * 2 : 0.06;
      const centerX = w / 2;
      const centerY = h / 2;

      blobs.forEach((b, i) => {
        b.phase += b.wobbleSpd * speedMult;

        // Bass makes blobs pulse in size
        const bassPulse = energy.bass * 60;
        // Mid makes blobs wobble
        const midWobble = energy.mid * 35;
        // High makes them shimmer
        const highShimmer = energy.high * 15;

        b.r = b.baseR + bassPulse + Math.sin(b.phase * 2.3 + i) * midWobble;
        b.wobble = Math.sin(b.phase) * (12 + highShimmer);

        // Orbital motion around center + drift
        const orbitSpeed = isActuallyPlaying ? 0.0008 + energy.overall * 0.003 : 0.0002;
        b.angleOffset += orbitSpeed * (i % 2 === 0 ? 1 : -1);
        const orbitRadius = 40 + energy.bass * 80 + Math.sin(b.phase * 0.7) * 20;

        const targetX = centerX + Math.cos(b.angleOffset) * orbitRadius;
        const targetY = centerY + Math.sin(b.angleOffset) * orbitRadius;

        // Smooth move towards orbital position
        b.x += (targetX - b.x) * 0.03 + b.vx * speedMult;
        b.y += (targetY - b.y) * 0.03 + b.vy * speedMult;

        // Keep in bounds softly
        if (b.x < -b.r * 0.5) b.x = -b.r * 0.5;
        if (b.x > w + b.r * 0.5) b.x = w + b.r * 0.5;
        if (b.y < -b.r * 0.5) b.y = -b.r * 0.5;
        if (b.y > h + b.r * 0.5) b.y = h + b.r * 0.5;

        const effectiveR = Math.max(10, b.r + b.wobble);
        const gradient = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, effectiveR);
        const baseOpacity = isActuallyPlaying ? 0.25 + energy.overall * 0.35 : 0.1;
        const [cr, cg, cb] = b.color;
        gradient.addColorStop(0, `rgba(${cr}, ${cg}, ${cb}, ${baseOpacity})`);
        gradient.addColorStop(0.5, `rgba(${cr}, ${cg}, ${cb}, ${baseOpacity * 0.5})`);
        gradient.addColorStop(1, `rgba(${cr}, ${cg}, ${cb}, 0)`);

        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(b.x, b.y, effectiveR, 0, Math.PI * 2);
        ctx.fill();
      });

      // Central glow — reacts to overall energy
      if (isActuallyPlaying && energy.overall > 0.05) {
        const glowR = 60 + energy.overall * 100;
        const glowGrad = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, glowR);
        const glowAlpha = energy.overall * 0.18;
        glowGrad.addColorStop(0, `rgba(255, 255, 255, ${glowAlpha})`);
        glowGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = glowGrad;
        ctx.beginPath();
        ctx.arc(centerX, centerY, glowR, 0, Math.PI * 2);
        ctx.fill();
      }

      animationFrameId = requestAnimationFrame(draw);
    };

    animationFrameId = requestAnimationFrame(draw);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(animationFrameId);
      unlistenAudio?.();
    };
  }, [isPlaying, isActive]);

  const runWaveWithLoading = (preset: SoundWavePreset) => {
    awaitingFirstPlayableRef.current = false;
    setIsAwaitingFirstTrack(true);
    setShowRestartAfterLanguageChange(false);
    void startWave(preset);
  };

  const handleCacheOnClose = () => {
    awaitingFirstPlayableRef.current = false;
    setIsAwaitingFirstTrack(false);

    if (isActive && !isSuspended && queue.length > 0) {
      suspendForExternalPlayback(queue, queueIndex);
      pausePlayback();
    } else if (!isSuspended) {
      stopWave();
    }

    setShowRestartAfterLanguageChange(false);
  };

  const handleToggleWave = () => {
    if (isActive) {
      if (isSuspended) {
        awaitingFirstPlayableRef.current = false;
        setIsAwaitingFirstTrack(true);
        const resumed = resumeSuspendedPlayback();
        if (!resumed) {
          runWaveWithLoading(selectedPreset);
        }
        return;
      }
      togglePlay();
    } else {
      runWaveWithLoading(selectedPreset);
    }
  };

  const handleSelectPreset = (presetKey: SoundWavePresetKey) => {
    setSoundwavePresetKey(presetKey);
  };

  const handleLanguageToggle = () => {
    const nextEnabled = !languageFilterEnabled;
    setLanguageFilterEnabled(nextEnabled);
    if (isActive) {
      setShowRestartAfterLanguageChange(true);
    }
  };

  const handleLanguageSelect = (nextLanguage: string) => {
    const hasLanguageChanged = nextLanguage !== preferredLanguage;
    const shouldEnable = nextLanguage !== 'all' && !languageFilterEnabled;
    setPreferredLanguage(nextLanguage);
    if (shouldEnable) {
      setLanguageFilterEnabled(true);
    }
    if (isActive && (hasLanguageChanged || shouldEnable)) {
      setShowRestartAfterLanguageChange(true);
    }
  };

  const handleToggleGenreStrict = () => {
    setSoundwaveGenreStrict(!soundwaveGenreStrict);
    if (isActive) {
      setShowRestartAfterLanguageChange(true);
    }
  };

  const handleToggleGenre = (genre: string) => {
    const exists = soundwaveSelectedGenres.includes(genre);
    const next = exists
      ? soundwaveSelectedGenres.filter((value) => value !== genre)
      : [...soundwaveSelectedGenres, genre];
    setSoundwaveSelectedGenres(next);
    if (isActive) {
      setShowRestartAfterLanguageChange(true);
    }
  };

  const handleClearGenres = () => {
    if (soundwaveSelectedGenres.length === 0) return;
    setSoundwaveSelectedGenres([]);
    if (isActive) {
      setShowRestartAfterLanguageChange(true);
    }
  };

  const selectedLanguage = SUPPORTED_LANGUAGES.find((lang) => lang.code === preferredLanguage);
  const selectedLanguageFlagUrl =
    preferredLanguage === 'all' ? null : getLanguageFlagUrl(preferredLanguage);
  const selectedLanguageLabel =
    preferredLanguage === 'all'
      ? t('settings.languageWaveAll')
      : selectedLanguage?.nativeName || preferredLanguage.toUpperCase();
  const isWaveLoading = isInitialLoading || isAwaitingFirstTrack;
  const showStartupProgress = startupVisible || isWaveLoading;
  const progressValue = Math.max(isWaveLoading ? 8 : 0, startupProgress);
  const stageLabelByKey: Record<string, string> = {
    preset: t('settings.soundwaveStagePreset'),
    init: t('settings.soundwaveStageInit'),
    qdrant: t('settings.soundwaveStageQdrant'),
    likes: t('settings.soundwaveStageLikes'),
    explore: t('settings.soundwaveStageExplore'),
    weights: t('settings.soundwaveStageWeights'),
    seed: t('settings.soundwaveStageSeed'),
    batch: t('settings.soundwaveStageBatch'),
    filter: t('settings.soundwaveStageFilter'),
    language: t('settings.soundwaveStageLanguage'),
    done: t('settings.soundwaveStageDone'),
    caching: t('settings.languageWaveCaching'),
  };
  const startupStageLabel = stageLabelByKey[startupStage] || t('common.loading');
  const isWavePlaying = isActive && !isSuspended && isPlaying;
  const selectedGenreLabels = soundwaveSelectedGenres.reduce<string[]>((acc, value) => {
    const option = SOUNDWAVE_GENRE_OPTIONS.find((entry) => entry.value === value);
    if (option) {
      acc.push(t(option.labelKey));
    }
    return acc;
  }, []);
  const hasGenreSubtitle = isActive && selectedGenreLabels.length > 0;
  const selectedGenresSummary = selectedGenreLabels.join(', ');
  const selectedGenresMenuLabel =
    selectedGenreLabels.length === 0
      ? t('settings.genreFilterAll')
      : selectedGenreLabels.length === 1
        ? selectedGenreLabels[0]
        : t('settings.genreFilterSelected', { count: selectedGenreLabels.length });
  const enabledHeroToggleClass =
    'bg-accent/25 hover:bg-accent/35 text-white border-accent/45 shadow-[0_0_20px_var(--color-accent-glow)] hover:brightness-110';
  const enabledHeroToggleStyle: React.CSSProperties = {
    backgroundColor: 'color-mix(in oklab, var(--color-accent) 26%, rgba(255,255,255,0.08))',
    borderColor: 'color-mix(in oklab, var(--color-accent) 44%, rgba(255,255,255,0.14))',
  };
  const heroSecondaryButtonClass =
    'flex items-center gap-2 px-5 py-2.5 rounded-full bg-white/10 border border-white/10 text-white/70 text-sm font-medium transition-all duration-300 hover:bg-white/20 hover:text-white active:scale-95';

  return (
    <div className="relative w-full h-[220px] rounded-3xl overflow-hidden group/sw border border-white/[0.04] shadow-2xl bg-[#0a0a0c]">
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />

      {showStartupProgress && (
        <div className="absolute top-3 left-3 right-3 z-30 pointer-events-none">
          <div className="px-1 py-1">
            <div className="h-1.5 w-full bg-white/12 overflow-hidden">
              <div
                className="h-full bg-accent shadow-[0_0_16px_var(--color-accent-glow)] transition-[width] duration-500 ease-out"
                style={{ width: `${Math.max(0, Math.min(100, progressValue))}%` }}
              />
            </div>
            <div className="mt-1 text-center px-1 text-[10px] font-medium text-white/55">
              {startupStageLabel} • {Math.round(progressValue)}%
            </div>
          </div>
        </div>
      )}

      {/* Content overlay */}
      <div className="absolute inset-0 flex flex-col items-center justify-center p-6 bg-gradient-to-b from-transparent via-transparent to-black/20">
        <div
          className={`mb-6 flex flex-col items-center gap-1.5 max-w-[88%] ${
            hasGenreSubtitle ? 'mt-2' : ''
          }`}
        >
          <h2 className="text-xl font-bold text-white/90 tracking-wide drop-shadow-md flex items-center gap-2">
            {isActive ? `Волна: ${currentPreset?.name}` : 'СаундВолна'}
            {isSuspended && (
              <span className="rounded-full border border-accent/35 bg-accent/12 px-2 py-0.5 text-[10px] font-semibold text-white/80">
                {t('settings.languageWaveCaching')}
              </span>
            )}
          </h2>

          {hasGenreSubtitle && (
            <p className="max-w-[360px] truncate text-[11px] text-white/45 text-center font-medium">
              {t('settings.genreFilterTitle')}: {selectedGenresSummary}
            </p>
          )}
        </div>

        <div className="flex flex-col items-center gap-2">
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handleToggleWave();
              }}
              disabled={isWaveLoading}
              className="w-16 h-16 rounded-full bg-white text-black flex items-center justify-center shadow-2xl transition-all duration-300 hover:scale-110 active:scale-95 z-10 disabled:opacity-50"
            >
              {isWaveLoading ? (
                <Loader2 className="animate-spin" size={24} />
              ) : isWavePlaying ? (
                <Pause fill="currentColor" size={24} />
              ) : (
                <Play fill="currentColor" size={24} className="ml-1" />
              )}
            </button>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setIsPanelOpen(true);
              }}
              className={`${heroSecondaryButtonClass} z-10`}
            >
              <Settings size={15} />
              <span>Настроить</span>
            </button>
          </div>

          {showRestartAfterLanguageChange && isActive && (
            <button
              type="button"
              onClick={() => runWaveWithLoading(selectedPreset)}
              className="flex items-center gap-2 px-4 py-2.5 rounded-full bg-accent hover:bg-accent-hover text-accent-contrast text-sm font-semibold transition-all duration-300 active:scale-95 shadow-[0_0_18px_var(--color-accent-glow)]"
            >
              <RefreshCw size={14} />
              <span>{t('settings.restartWave')}</span>
            </button>
          )}
        </div>
      </div>

      <div className="absolute bottom-3 right-3 z-20 flex flex-col items-end gap-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleToggleGenreStrict}
            className={`${heroSecondaryButtonClass} ${
              soundwaveGenreStrict ? enabledHeroToggleClass : 'text-white/60 hover:text-white'
            }`}
            style={soundwaveGenreStrict ? enabledHeroToggleStyle : undefined}
          >
            {soundwaveGenreStrict
              ? t('settings.genreFilterStrictOn')
              : t('settings.genreFilterStrictOff')}
          </button>

          <div className="relative">
            <button
              type="button"
              aria-label={t('settings.genreFilterTitle')}
              ref={genreMenuButtonRef}
              onClick={() => {
                setIsLanguageMenuOpen(false);
                setIsGenreMenuOpen((prev) => !prev);
              }}
              className={`${heroSecondaryButtonClass} max-w-[220px] ${
                soundwaveSelectedGenres.length > 0
                  ? 'bg-accent/12 border-accent/35 text-white/90 shadow-[0_0_12px_var(--color-accent-glow)]'
                  : ''
              }`}
            >
              <Music size={14} />
              <span className="truncate">{selectedGenresMenuLabel}</span>
              <ChevronDown
                size={12}
                className={`shrink-0 transition-transform ${isGenreMenuOpen ? 'rotate-180' : ''}`}
              />
            </button>

            {isGenreMenuOpen &&
              genreMenuPosition &&
              createPortal(
                <>
                  <button
                    type="button"
                    className="fixed inset-0 z-[340] cursor-default"
                    aria-label={t('common.close')}
                    onClick={() => setIsGenreMenuOpen(false)}
                  />
                  <div
                    className="fixed z-[350] w-[232px] overflow-hidden rounded-xl border border-white/10 bg-[#121215] shadow-2xl"
                    style={{
                      top: `${genreMenuPosition.top}px`,
                      left: `${genreMenuPosition.left}px`,
                    }}
                  >
                    <div className="border-b border-white/10 px-3 py-2.5">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/45">
                        {t('settings.genreFilterTitle')}
                      </p>
                      <p className="mt-1 text-[10px] text-white/35">
                        {t('settings.genreFilterHint')}
                      </p>
                    </div>
                    <div className="max-h-72 overflow-y-auto p-1.5">
                      <button
                        type="button"
                        onClick={handleClearGenres}
                        className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-semibold transition-colors ${
                          soundwaveSelectedGenres.length === 0
                            ? 'bg-white/15 text-white'
                            : 'text-white/70 hover:bg-white/10 hover:text-white'
                        }`}
                      >
                        <span
                          className={`flex h-4 w-4 items-center justify-center rounded border ${
                            soundwaveSelectedGenres.length === 0
                              ? 'border-white/80 bg-white/90 text-black'
                              : 'border-white/20 bg-white/5 text-white/20'
                          }`}
                        >
                          {soundwaveSelectedGenres.length === 0 && <Check size={11} />}
                        </span>
                        <span className="flex-1">{t('settings.genreFilterAll')}</span>
                      </button>

                      {SOUNDWAVE_GENRE_OPTIONS.map((option) => {
                        const active = soundwaveSelectedGenres.includes(option.value);
                        return (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => handleToggleGenre(option.value)}
                            className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-semibold transition-colors ${
                              active
                                ? 'bg-white/15 text-white'
                                : 'text-white/70 hover:bg-white/10 hover:text-white'
                            }`}
                          >
                            <span
                              className={`flex h-4 w-4 items-center justify-center rounded border ${
                                active
                                  ? 'border-white/80 bg-white/90 text-black'
                                  : 'border-white/20 bg-white/5 text-white/20'
                              }`}
                            >
                              {active && <Check size={11} />}
                            </span>
                            <span className="flex-1">{t(option.labelKey)}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </>,
                document.body,
              )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleLanguageToggle}
            className={`${heroSecondaryButtonClass} ${
              languageFilterEnabled ? enabledHeroToggleClass : 'text-white/60 hover:text-white'
            }`}
            style={languageFilterEnabled ? enabledHeroToggleStyle : undefined}
          >
            {languageFilterEnabled
              ? t('settings.languageWaveEnabled')
              : t('settings.languageWaveDisabled')}
          </button>

          <div className="relative">
            <button
              type="button"
              aria-label={t('settings.languageWaveSelect')}
              ref={languageMenuButtonRef}
              onClick={() => {
                setIsGenreMenuOpen(false);
                setIsLanguageMenuOpen((prev) => !prev);
              }}
              className={`${heroSecondaryButtonClass} ${
                languageFilterEnabled
                  ? 'bg-accent/12 border-accent/35 text-white/85 shadow-[0_0_12px_var(--color-accent-glow)]'
                  : ''
              }`}
            >
              {selectedLanguageFlagUrl ? (
                <img
                  src={selectedLanguageFlagUrl}
                  alt=""
                  className="w-[15px] h-[11px] rounded-[2px] object-cover"
                />
              ) : (
                <Globe size={15} />
              )}
              <span>{selectedLanguageLabel}</span>
              <ChevronDown
                size={12}
                className={`transition-transform ${isLanguageMenuOpen ? 'rotate-180' : ''}`}
              />
            </button>

            {isLanguageMenuOpen &&
              languageMenuPosition &&
              createPortal(
                <>
                  <button
                    type="button"
                    className="fixed inset-0 z-[340] cursor-default"
                    aria-label={t('common.close')}
                    onClick={() => setIsLanguageMenuOpen(false)}
                  />
                  <div
                    className="fixed z-[350] w-44 overflow-hidden rounded-xl border border-white/10 bg-[#121215] shadow-2xl"
                    style={{
                      top: `${languageMenuPosition.top}px`,
                      left: `${languageMenuPosition.left}px`,
                    }}
                  >
                    <div className="max-h-64 overflow-y-auto p-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          handleLanguageSelect('all');
                          setIsLanguageMenuOpen(false);
                        }}
                        className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-semibold transition-colors ${
                          preferredLanguage === 'all'
                            ? 'bg-white/15 text-white'
                            : 'text-white/70 hover:bg-white/10 hover:text-white'
                        }`}
                      >
                        <Globe size={12} className="w-5 text-white/65" />
                        <span className="flex-1">{t('settings.languageWaveAll')}</span>
                        {preferredLanguage === 'all' && <Check size={12} />}
                      </button>
                      {SUPPORTED_LANGUAGES.map((lang) => {
                        const active = preferredLanguage === lang.code;
                        const flagUrl = getLanguageFlagUrl(lang.code);
                        return (
                          <button
                            key={lang.code}
                            type="button"
                            onClick={() => {
                              handleLanguageSelect(lang.code);
                              setIsLanguageMenuOpen(false);
                            }}
                            className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-semibold transition-colors ${
                              active
                                ? 'bg-white/15 text-white'
                                : 'text-white/70 hover:bg-white/10 hover:text-white'
                            }`}
                          >
                            {flagUrl ? (
                              <img
                                src={flagUrl}
                                alt=""
                                className="w-4 h-3 rounded-[2px] object-cover"
                              />
                            ) : (
                              <span className="w-4 text-[10px] font-bold text-white/55 text-center">
                                {lang.code.toUpperCase()}
                              </span>
                            )}
                            <span className="flex-1">{lang.nativeName}</span>
                            {active && <Check size={12} />}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </>,
                document.body,
              )}
          </div>
        </div>
      </div>

      {/* Redesigned Settings Modal (Global Fixed Overlay) */}
      {isPanelOpen && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center px-4 pt-6 pb-28">
          <div
            className="absolute inset-0 bg-black/80 backdrop-blur-md animate-fade-in"
            onClick={() => setIsPanelOpen(false)}
          />
          <div className="relative w-full max-w-[440px] max-h-[calc(100vh-140px)] bg-[rgb(18,18,20)] border border-white/10 rounded-[32px] p-7 shadow-[0_32px_128px_rgba(0,0,0,0.8)] animate-fade-in-up flex flex-col gap-6 overflow-hidden min-h-0">
            {/* Header */}
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-2xl font-bold text-white tracking-tight">СаундВолна</h3>
                <p className="text-[11px] text-white/40 mt-0.5">
                  Умный подбор музыки на основе аудиоанализа
                </p>
              </div>
              <button
                onClick={() => setIsPanelOpen(false)}
                className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 transition-all border border-white/5"
              >
                <X size={16} />
              </button>
            </div>

            <div className="space-y-6 overflow-y-auto pr-1 min-h-0 flex-1 scrollbar-hide">
              {/* Activity Section */}
              <div className="space-y-3">
                <p className="text-[10px] font-bold text-white/30 uppercase tracking-[0.15em]">
                  ПОД ЗАНЯТИЕ
                </p>
                <div className="flex gap-2.5">
                  {[
                    { key: 'wakeup' as const, icon: Sun, label: 'Просыпаюсь' },
                    { key: 'commute' as const, icon: Car, label: 'В дороге' },
                    { key: 'work' as const, icon: Laptop, label: 'Работаю' },
                    { key: 'workout' as const, icon: Dumbbell, label: 'Тренируюсь' },
                    { key: 'sleep' as const, icon: Moon, label: 'Засыпаю' },
                  ].map(({ key, icon: Icon, label }) => {
                    const active = selectedPresetKey === key;
                    return (
                      <button
                        key={label}
                        onClick={() => handleSelectPreset(key)}
                        className={`flex-1 flex flex-col items-center gap-2 px-1 py-3 rounded-2xl border transition-all group ${
                          active
                            ? 'bg-white/10 border-white/20 text-white'
                            : 'bg-white/[0.03] border-white/[0.03] text-white/40 hover:bg-white/5 hover:border-white/10 hover:text-white'
                        }`}
                      >
                        <Icon
                          size={18}
                          className={active ? 'opacity-100' : 'opacity-60 group-hover:opacity-100'}
                        />
                        <span className="text-[9px] font-bold leading-none">{label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Mood Section */}
              <div className="space-y-3 border-t border-white/[0.05] pt-5">
                <p className="text-[10px] font-bold text-white/30 uppercase tracking-[0.15em]">
                  НАСТРОЕНИЕ
                </p>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    {
                      key: 'energetic' as const,
                      icon: Zap,
                      label: 'Бодрое',
                      color: 'border-orange-500/50 bg-orange-500/10 text-orange-400',
                    },
                    {
                      key: 'happy' as const,
                      icon: Music,
                      label: 'Весёлое',
                      color:
                        'border-emerald-500/10 bg-emerald-500/5 text-emerald-400/80 hover:border-emerald-500/30',
                    },
                    {
                      key: 'calm' as const,
                      icon: Waves,
                      label: 'Спокойное',
                      color:
                        'border-indigo-500/10 bg-indigo-500/5 text-indigo-400/80 hover:border-indigo-500/30',
                    },
                    {
                      key: 'sad' as const,
                      icon: Frown,
                      label: 'Грустное',
                      color:
                        'border-slate-500/10 bg-slate-500/5 text-slate-400/80 hover:border-slate-500/30',
                    },
                  ].map(({ key, icon: Icon, label, color }) => {
                    const active = selectedPresetKey === key;
                    return (
                      <button
                        key={label}
                        onClick={() => handleSelectPreset(key)}
                        className={`flex items-center gap-3 p-4 rounded-2xl border transition-all text-left group ${
                          active
                            ? color
                            : 'border-white/5 bg-white/[0.03] text-white/50 hover:bg-white/10 hover:text-white'
                        } ${active ? 'shadow-[0_0_20px_rgba(249,115,22,0.15)]' : ''}`}
                      >
                        <div
                          className={`p-2 rounded-xl ${active ? 'bg-current/10' : 'bg-white/5'}`}
                        >
                          <Icon size={20} />
                        </div>
                        <span className="text-sm font-bold tracking-wide">{label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Character Section */}
              <div className="space-y-3 border-t border-white/[0.05] pt-5">
                <p className="text-[10px] font-bold text-white/30 uppercase tracking-[0.15em]">
                  ХАРАКТЕР
                </p>
                <div className="flex gap-2">
                  {[
                    { key: 'favorite' as const, icon: Heart, label: 'Любимое' },
                    { key: 'discover' as const, icon: Sparkles, label: 'Незнакомое' },
                    { key: 'popular' as const, icon: Zap, label: 'Популярное' },
                  ].map(({ key, icon: Icon, label }) => {
                    const active = selectedPresetKey === key;
                    return (
                      <button
                        key={label}
                        onClick={() => handleSelectPreset(key)}
                        className={`flex-1 flex items-center justify-center gap-2.5 py-3.5 rounded-2xl border transition-all text-xs font-bold ${
                          active
                            ? 'bg-white/10 border-white/20 text-white'
                            : 'bg-white/[0.03] border-white/[0.03] text-white/50 hover:bg-white/5 hover:border-white/10 hover:text-white'
                        }`}
                      >
                        <Icon size={14} className={active ? 'text-orange-500' : ''} />
                        <span>{label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Language Wave Section */}
              <div className="space-y-3 border-t border-white/[0.05] pt-5">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-bold text-white/30 uppercase tracking-[0.15em]">
                    ЯЗЫК ФИЛЬТРА
                  </p>
                  <button
                    onClick={() => {
                      handleLanguageToggle();
                    }}
                    className={`px-3 py-1 rounded-full text-[10px] font-bold transition-all ${
                      languageFilterEnabled
                        ? 'bg-accent hover:bg-accent-hover text-accent-contrast shadow-[0_0_16px_var(--color-accent-glow)]'
                        : 'bg-white/10 text-white/50 hover:text-white'
                    }`}
                  >
                    {languageFilterEnabled
                      ? t('settings.languageWaveEnabled')
                      : t('settings.languageWaveDisabled')}
                  </button>
                </div>

                {languageFilterEnabled && (
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 max-h-56 overflow-y-auto pr-1">
                    <button
                      onClick={() => {
                        handleLanguageSelect('all');
                      }}
                      className={`flex items-center justify-center gap-1.5 py-2.5 rounded-xl border text-[10px] font-bold transition-all ${
                        preferredLanguage === 'all'
                          ? 'bg-white/15 border-white/20 text-white'
                          : 'bg-white/[0.03] border-white/[0.03] text-white/50 hover:bg-white/5 hover:text-white'
                      }`}
                    >
                      <Globe size={12} />
                      <span>{t('settings.languageWaveAll')}</span>
                    </button>
                    {SUPPORTED_LANGUAGES.map((lang) => {
                      const active = preferredLanguage === lang.code;
                      const flagUrl = getLanguageFlagUrl(lang.code);
                      return (
                        <button
                          key={lang.code}
                          onClick={() => {
                            handleLanguageSelect(lang.code);
                          }}
                          className={`flex items-center justify-center gap-1 py-2 rounded-xl border text-[10px] font-bold transition-all ${
                            active
                              ? 'bg-white/15 border-white/20 text-white'
                              : 'bg-white/[0.03] border-white/[0.03] text-white/50 hover:bg-white/5 hover:text-white'
                          }`}
                        >
                          {flagUrl ? (
                            <img
                              src={flagUrl}
                              alt=""
                              className="w-4 h-3 rounded-[2px] object-cover"
                            />
                          ) : (
                            <span className="text-[9px] font-bold text-white/55">
                              {lang.code.toUpperCase()}
                            </span>
                          )}
                          <span>{lang.nativeName}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Genre Strict Section */}
              <div className="space-y-3 border-t border-white/[0.05] pt-5">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-bold text-white/30 uppercase tracking-[0.15em]">
                    {t('settings.genreFilterTitle')}
                  </p>
                  <button
                    onClick={handleToggleGenreStrict}
                    className={`px-3 py-1 rounded-full text-[10px] font-bold transition-all ${
                      soundwaveGenreStrict
                        ? 'bg-accent hover:bg-accent-hover text-accent-contrast shadow-[0_0_16px_var(--color-accent-glow)]'
                        : 'bg-white/10 text-white/50 hover:text-white'
                    }`}
                  >
                    {soundwaveGenreStrict
                      ? t('settings.genreFilterStrictOn')
                      : t('settings.genreFilterStrictOff')}
                  </button>
                </div>

                <p className="text-[11px] text-white/35">{t('settings.genreFilterHint')}</p>

                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-white/55">{t('settings.soundwaveHideLiked')}</span>
                  <button
                    type="button"
                    onClick={() => setSoundwaveHideLiked(!soundwaveHideLiked)}
                    className={`px-3 py-1 rounded-full text-[10px] font-bold transition-all ${
                      soundwaveHideLiked
                        ? 'bg-accent hover:bg-accent-hover text-accent-contrast shadow-[0_0_16px_var(--color-accent-glow)]'
                        : 'bg-white/10 text-white/50 hover:text-white'
                    }`}
                  >
                    {soundwaveHideLiked ? t('eq.on') : t('eq.off')}
                  </button>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-white/55">{t('settings.soundwaveTrackVisual')}</span>
                  <button
                    type="button"
                    onClick={() => setSoundwaveTrackVisual(!soundwaveTrackVisual)}
                    className={`px-3 py-1 rounded-full text-[10px] font-bold transition-all ${
                      soundwaveTrackVisual
                        ? 'bg-accent hover:bg-accent-hover text-accent-contrast shadow-[0_0_16px_var(--color-accent-glow)]'
                        : 'bg-white/10 text-white/50 hover:text-white'
                    }`}
                  >
                    {soundwaveTrackVisual ? t('eq.on') : t('eq.off')}
                  </button>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {SOUNDWAVE_GENRE_OPTIONS.map((option) => {
                    const active = soundwaveSelectedGenres.includes(option.value);
                    return (
                      <button
                        key={option.value}
                        onClick={() => handleToggleGenre(option.value)}
                        className={`flex items-center justify-center gap-1 py-2 rounded-xl border text-[10px] font-bold transition-all ${
                          active
                            ? 'bg-white/15 border-white/20 text-white'
                            : 'bg-white/[0.03] border-white/[0.03] text-white/50 hover:bg-white/5 hover:text-white'
                        }`}
                      >
                        <span>{t(option.labelKey)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="space-y-2.5">
              <button
                onClick={() => {
                  runWaveWithLoading(selectedPreset);
                  setIsPanelOpen(false);
                }}
                className="w-full flex items-center justify-center gap-2 py-4 rounded-2xl bg-[#ff5500] text-white font-bold text-[15px] transition-all hover:scale-[1.02] active:scale-[0.98] shadow-lg shadow-orange-500/20 group"
              >
                <Play
                  size={16}
                  fill="white"
                  className="group-hover:translate-x-0.5 transition-transform"
                />
                <span>{t('settings.restartWave')}</span>
              </button>
              <button
                onClick={() => {
                  handleCacheOnClose();
                  setIsPanelOpen(false);
                }}
                className="w-full flex items-center justify-center gap-2 py-4 rounded-2xl bg-[#2a1313] text-[#f87171] font-bold text-[15px] transition-all hover:bg-[#3d1a1a] border border-white/[0.02]"
              >
                <div className="w-2.5 h-2.5 bg-[#f87171] rounded-sm" />
                <span>Выключить</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
