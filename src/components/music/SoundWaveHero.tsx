import {
  Car,
  Dumbbell,
  Frown,
  Globe,
  Heart,
  Laptop,
  Loader2,
  Moon,
  Music,
  Sparkles,
  Sun,
  Waves,
  X,
  Zap,
} from 'lucide-react';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
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
  r: number;
  color: number[];
  phase: number;
  wobble: number;
  wobbleSpd: number;
}

export const SoundWaveHero: React.FC = () => {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isPrefetchingRef = useRef(false);
  const [isPanelOpen, setIsPanelOpen] = useState(false);

  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const queueIndex = usePlayerStore((s) => s.queueIndex);
  const queueLength = usePlayerStore((s) => s.queue.length);
  const addToQueue = usePlayerStore((s) => s.addToQueue);

  const isActive = useSoundWaveStore((s) => s.isActive);
  const currentPreset = useSoundWaveStore((s) => s.currentPreset);
  const startWave = useSoundWaveStore((s) => s.start);
  const stopWave = useSoundWaveStore((s) => s.stop);
  const generateBatch = useSoundWaveStore((s) => s.generateBatch);
  const isInitialLoading = useSoundWaveStore((s) => s.isInitialLoading);
  const selectedPresetKey = useSettingsStore((s) => s.soundwavePresetKey);
  const setSoundwavePresetKey = useSettingsStore((s) => s.setSoundwavePresetKey);
  const languageFilterEnabled = useSettingsStore((s) => s.languageFilterEnabled);
  const preferredLanguage = useSettingsStore((s) => s.preferredLanguage);
  const setLanguageFilterEnabled = useSettingsStore((s) => s.setLanguageFilterEnabled);
  const setPreferredLanguage = useSettingsStore((s) => s.setPreferredLanguage);
  const selectedPreset = getPresetByKey(selectedPresetKey);

  // Prefetching logic
  useEffect(() => {
    if (!isActive) return;
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
  }, [isActive, queueIndex, queueLength, generateBatch, addToQueue, isInitialLoading]);

  // Animation logic
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let lastFrameTime = 0;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const blobs: Blob[] = [];
    const blobCount = reducedMotion ? 2 : 4;

    const resize = () => {
      canvas.width = canvas.offsetWidth * window.devicePixelRatio;
      canvas.height = canvas.offsetHeight * window.devicePixelRatio;
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    };

    window.addEventListener('resize', resize);
    resize();

    // SoundWave colors
    const colors = [
      [255, 85, 0], // SoundCloud Orange
      [255, 45, 85], // Pinkish
      [191, 90, 242], // Purple
      [94, 92, 230], // Blue
      [255, 159, 10], // Orange
      [255, 69, 58], // Red
    ];

    for (let i = 0; i < blobCount; i++) {
      blobs.push({
        x: Math.random() * canvas.offsetWidth,
        y: Math.random() * canvas.offsetHeight,
        vx: (Math.random() - 0.5) * 0.8,
        vy: (Math.random() - 0.5) * 0.8,
        r: 100 + Math.random() * 150,
        color: colors[i % colors.length],
        phase: Math.random() * Math.PI * 2,
        wobble: 0,
        wobbleSpd: 0.02 + Math.random() * 0.03,
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
      const targetFps = reducedMotion ? 6 : isActuallyPlaying ? 24 : 2;
      const frameInterval = 1000 / targetFps;
      if (ts - lastFrameTime < frameInterval) {
        animationFrameId = requestAnimationFrame(draw);
        return;
      }
      lastFrameTime = ts;

      ctx.clearRect(0, 0, w, h);
      ctx.filter = reducedMotion ? 'blur(24px)' : 'blur(36px)';
      ctx.globalCompositeOperation = 'screen';

      const speedMult = isActuallyPlaying ? 1.5 : 0.08;

      blobs.forEach((b) => {
        b.x += b.vx * speedMult;
        b.y += b.vy * speedMult;
        b.phase += b.wobbleSpd * speedMult;
        b.wobble = Math.sin(b.phase) * 20;

        if (b.x < -b.r) b.x = w + b.r;
        if (b.x > w + b.r) b.x = -b.r;
        if (b.y < -b.r) b.y = h + b.r;
        if (b.y > h + b.r) b.y = -b.r;

        const gradient = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r + b.wobble);
        const opacity = isActuallyPlaying ? 0.4 : 0.15;
        gradient.addColorStop(0, `rgba(${b.color[0]}, ${b.color[1]}, ${b.color[2]}, ${opacity})`);
        gradient.addColorStop(1, `rgba(${b.color[0]}, ${b.color[1]}, ${b.color[2]}, 0)`);

        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r + b.wobble, 0, Math.PI * 2);
        ctx.fill();
      });

      animationFrameId = requestAnimationFrame(draw);
    };

    animationFrameId = requestAnimationFrame(draw);
    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(animationFrameId);
    };
  }, [isPlaying, isActive]);

  const handleToggleWave = () => {
    if (isActive) {
      togglePlay();
    } else {
      startWave(selectedPreset);
    }
  };

  const handleSelectPreset = (presetKey: SoundWavePresetKey) => {
    setSoundwavePresetKey(presetKey);
  };

  return (
    <div className="relative w-full h-[220px] rounded-3xl overflow-hidden group/sw border border-white/[0.04] shadow-2xl bg-[#0a0a0c]">
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />

      {/* Content overlay */}
      <div className="absolute inset-0 flex flex-col items-center justify-center p-6 bg-gradient-to-b from-transparent via-transparent to-black/20">
        <h2 className="text-xl font-bold text-white/90 mb-6 tracking-wide drop-shadow-md">
          {isActive ? `Волна: ${currentPreset?.name}` : 'СаундВолна'}
        </h2>

        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleToggleWave();
            }}
            disabled={isInitialLoading}
            className="w-16 h-16 rounded-full bg-white text-black flex items-center justify-center shadow-2xl transition-all duration-300 hover:scale-110 active:scale-95 z-10 disabled:opacity-50"
          >
            {isInitialLoading ? (
              <Loader2 className="animate-spin" size={24} />
            ) : isPlaying && isActive ? (
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
            className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-white/10 border border-white/10 text-white/70 text-sm font-medium transition-all duration-300 hover:bg-white/20 hover:text-white active:scale-95 z-10"
          >
            <Settings size={15} />
            <span>Настроить</span>
          </button>
        </div>
      </div>

      {/* Redesigned Settings Modal (Global Fixed Overlay) */}
      {isPanelOpen && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center px-4 pt-6 pb-28">
          <div
            className="absolute inset-0 bg-black/80 backdrop-blur-md animate-fade-in"
            onClick={() => setIsPanelOpen(false)}
          />
          <div className="relative w-full max-w-[440px] max-h-[calc(100vh-140px)] bg-[rgb(18,18,20)] border border-white/10 rounded-[32px] p-7 shadow-[0_32px_128px_rgba(0,0,0,0.8)] animate-fade-in-up flex flex-col gap-6 overflow-hidden">
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

            <div className="space-y-6 overflow-y-auto pr-1 max-h-[70vh] scrollbar-hide">
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
                      const newEnabled = !languageFilterEnabled;
                      setLanguageFilterEnabled(newEnabled);
                      if (newEnabled && preferredLanguage !== 'all') {
                        generateBatch().then((newTracks) => {
                          if (newTracks.length > 0) {
                            addToQueue(newTracks);
                          }
                        });
                      }
                    }}
                    className={`px-3 py-1 rounded-full text-[10px] font-bold transition-all ${
                      languageFilterEnabled
                        ? 'bg-orange-500 text-white'
                        : 'bg-white/10 text-white/50 hover:text-white'
                    }`}
                  >
                    {languageFilterEnabled ? t('languageWaveEnabled') : t('languageWaveDisabled')}
                  </button>
                </div>

                {languageFilterEnabled && (
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      onClick={() => {
                        setPreferredLanguage('all');
                        generateBatch().then((newTracks) => {
                          if (newTracks.length > 0) {
                            addToQueue(newTracks);
                          }
                        });
                      }}
                      className={`flex items-center justify-center gap-1.5 py-2.5 rounded-xl border text-[10px] font-bold transition-all ${
                        preferredLanguage === 'all'
                          ? 'bg-white/15 border-white/20 text-white'
                          : 'bg-white/[0.03] border-white/[0.03] text-white/50 hover:bg-white/5 hover:text-white'
                      }`}
                    >
                      <Globe size={12} />
                      <span>{t('languageWaveAll')}</span>
                    </button>
                    {SUPPORTED_LANGUAGES.slice(0, 8).map((lang) => {
                      const active = preferredLanguage === lang.code;
                      return (
                        <button
                          key={lang.code}
                          onClick={() => {
                            setPreferredLanguage(lang.code);
                            generateBatch().then((newTracks) => {
                              if (newTracks.length > 0) {
                                addToQueue(newTracks);
                              }
                            });
                          }}
                          className={`flex items-center justify-center gap-1 py-2 rounded-xl border text-[10px] font-bold transition-all ${
                            active
                              ? 'bg-white/15 border-white/20 text-white'
                              : 'bg-white/[0.03] border-white/[0.03] text-white/50 hover:bg-white/5 hover:text-white'
                          }`}
                        >
                          <span>{lang.flags}</span>
                          <span>{lang.code.toUpperCase()}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Actions */}
            <div className="space-y-2.5">
              <button
                onClick={() => {
                  startWave(selectedPreset);
                  setIsPanelOpen(false);
                }}
                className="w-full flex items-center justify-center gap-2 py-4 rounded-2xl bg-[#ff5500] text-white font-bold text-[15px] transition-all hover:scale-[1.02] active:scale-[0.98] shadow-lg shadow-orange-500/20 group"
              >
                <Play
                  size={16}
                  fill="white"
                  className="group-hover:translate-x-0.5 transition-transform"
                />
                <span>Перезапустить</span>
              </button>
              <button
                onClick={() => {
                  stopWave();
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
