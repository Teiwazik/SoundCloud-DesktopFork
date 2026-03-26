import * as Slider from '@radix-ui/react-slider';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { artworkPanelApi } from '../../components/music/LyricsPanel';
import { api, getTrackComments } from '../../lib/api';
import {
  getCurrentTime,
  getDuration,
  getSmoothCurrentTime,
  handlePrev,
  seek,
  subscribe,
} from '../../lib/audio';
import { updateDiscordLyric } from '../../lib/discord';
import { art, formatTime } from '../../lib/formatters';
import { invalidateAllLikesCache } from '../../lib/hooks';
import { useIsMobile } from '../../lib/hooks/useIsMobile';
import {
  audioLines16,
  Ban,
  Heart,
  listMusic16,
  MicVocal,
  pauseBlack20,
  playBlack20,
  repeat1Icon16,
  repeatIcon16,
  shuffleIcon16,
  skipBack20,
  skipForward20,
  volume1Icon16,
  volume2Icon16,
  volumeXIcon16,
} from '../../lib/icons';
import { optimisticToggleLike } from '../../lib/likes';
import { searchLyrics } from '../../lib/lyrics';
import { useDislikesStore } from '../../stores/dislikes';
import { useArtworkStore, useLyricsStore } from '../../stores/lyrics';
import { type Track, usePlayerStore } from '../../stores/player';
import { useSettingsStore } from '../../stores/settings';
import { type MoodLabel, useSoundWaveStore } from '../../stores/soundwave';
import { EqualizerPanel } from '../music/EqualizerPanel';
import { StreamQualityBadge } from '../music/StreamQualityBadge';
import { Visualizer } from '../music/Visualizer';

/* ── Progress Slider ─────────────────────────────────────────── */

export const ProgressSlider = React.memo(() => {
  const duration = useSyncExternalStore(subscribe, getDuration);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const floatingComments = useSettingsStore((s) => s.floatingComments);
  const classicPlaybar = useSettingsStore((s) => s.classicPlaybar);

  const { data: comments } = useQuery({
    queryKey: ['comments', currentTrack?.urn],
    queryFn: () => getTrackComments(currentTrack!.urn),
    enabled: !!currentTrack && floatingComments,
    staleTime: 60 * 60 * 1000,
  });

  const [dragging, setDragging] = useState(false);
  const [dragValue, setDragValue] = useState(0);
  const [syncedValue, setSyncedValue] = useState(0);

  const draggingRef = useRef(false);
  const maskUrlRef = useRef<string | null>(null);

  // Waveform Mask Logic
  const [maskUri, setMaskUri] = useState<string>('');
  useEffect(() => {
    const url = currentTrack?.waveform_url;
    const releaseMask = () => {
      if (maskUrlRef.current) {
        URL.revokeObjectURL(maskUrlRef.current);
        maskUrlRef.current = null;
      }
    };

    releaseMask();

    if (!url) {
      setMaskUri('');
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    const jsonUrl = url.replace(/\.[^.]+$/, '.json');
    fetch(jsonUrl, { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) {
          throw new Error(`HTTP ${r.status}`);
        }
        const contentType = r.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
          throw new Error(`Invalid waveform content-type: ${contentType || 'unknown'}`);
        }
        return r.json();
      })
      .then((d) => {
        if (!d || !d.samples) return;
        const s = d.samples as number[];
        const c = document.createElement('canvas');
        const w = 720;
        const h = 40;
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        if (!ctx) return;
        ctx.fillStyle = 'black';
        let max = 1;
        for (let i = 0; i < s.length; i++) {
          if (s[i] > max) max = s[i];
        }
        const barW = 2;
        const gap = 1.5;
        const step = barW + gap;
        for (let i = 0; i < w; i += step) {
          const idx = Math.floor((i / w) * s.length);
          const amp = s[idx] / max;
          const barH = Math.max(2, amp * h);
          ctx.beginPath();
          ctx.roundRect(i, (h - barH) / 2, barW, barH, 2);
          ctx.fill();
        }

        c.toBlob((blob) => {
          if (cancelled) return;
          if (!blob) {
            setMaskUri('');
            return;
          }
          const next = URL.createObjectURL(blob);
          if (maskUrlRef.current) URL.revokeObjectURL(maskUrlRef.current);
          maskUrlRef.current = next;
          setMaskUri(next);
        }, 'image/png');
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof DOMException && e.name === 'AbortError') return;
        console.warn('Waveform load failed', e);
        setMaskUri('');
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [currentTrack?.waveform_url]);

  useEffect(() => {
    return () => {
      if (maskUrlRef.current) {
        URL.revokeObjectURL(maskUrlRef.current);
        maskUrlRef.current = null;
      }
    };
  }, []);

  // Keep slider state in sync without competing DOM mutations
  useEffect(() => {
    let rafId: number;
    let lastPaint = 0;

    const loop = (ts: number) => {
      rafId = requestAnimationFrame(loop);
      if (draggingRef.current || document.visibilityState === 'hidden' || !isPlaying) return;

      if (ts - lastPaint < 33) return;
      lastPaint = ts;

      setSyncedValue(getSmoothCurrentTime());
    };

    rafId = requestAnimationFrame(loop);
    const unsub = subscribe(() => {
      if (!draggingRef.current) {
        setSyncedValue(getCurrentTime());
      }
    });

    return () => {
      cancelAnimationFrame(rafId);
      unsub();
    };
  }, [isPlaying]);

  const displayValue = dragging ? dragValue : syncedValue;

  const onValueChange = useCallback(([v]: number[]) => {
    setDragValue(v);
    if (!draggingRef.current) {
      draggingRef.current = true;
      setDragging(true);
    }
  }, []);

  const onValueCommit = useCallback(([v]: number[]) => {
    seek(v);
    draggingRef.current = false;
    setDragging(false);
    setSyncedValue(v);
  }, []);

  // Markers (little dots) on the track
  const markers = React.useMemo(() => {
    if (!comments || !duration) return null;
    return comments
      .filter((c) => c.timestamp != null)
      .map((c) => {
        const left = (c.timestamp! / (duration * 1000)) * 100;
        return (
          <div
            key={c.id}
            className={`absolute top-1/2 -translate-y-1/2 w-0.5 h-0.5 rounded-full pointer-events-none ${
              maskUri && !classicPlaybar ? 'bg-white/30' : 'bg-white/10'
            }`}
            style={{ left: `${left}%` }}
          />
        );
      });
  }, [comments, duration, maskUri, classicPlaybar]);

  return (
    <div className="relative w-full flex items-center group/slider z-20">
      <Slider.Root
        className={`relative flex items-center w-full cursor-pointer select-none touch-none group/slider ${maskUri && !classicPlaybar ? 'h-6' : 'h-5'}`}
        value={[displayValue]}
        max={duration || 1}
        step={0.1}
        onValueChange={onValueChange}
        onValueCommit={onValueCommit}
      >
        <Slider.Track
          className={`relative grow transition-all duration-150 overflow-hidden ${maskUri && !classicPlaybar ? 'h-full' : 'h-[3px] rounded-full group-hover/slider:h-[5px]'}`}
          style={
            maskUri && !classicPlaybar
              ? {
                  maskImage: `url(${maskUri})`,
                  maskSize: '100% 100%',
                  WebkitMaskImage: `url(${maskUri})`,
                  WebkitMaskSize: '100% 100%',
                }
              : undefined
          }
        >
          <div className="absolute inset-0 bg-white/[0.08]" />
          <Slider.Range
            className={`absolute h-full will-change-transform ${maskUri ? 'bg-accent/90' : 'bg-accent rounded-full'}`}
          />
          {markers}
        </Slider.Track>
        {(!maskUri || classicPlaybar) && (
          <Slider.Thumb className="block w-3 h-3 rounded-full bg-accent shadow-[0_0_10px_var(--color-accent-glow)] scale-0 opacity-0 group-hover/slider:scale-100 group-hover/slider:opacity-100 transition-all duration-150 outline-none will-change-transform" />
        )}
      </Slider.Root>
    </div>
  );
});

/* ── Volume Slider ───────────────────────────────────────────── */

const VolumeSlider = React.memo(({ className = '' }: { className?: string }) => {
  const volume = usePlayerStore((s) => s.volume);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const isOver100 = volume > 100;

  return (
    <div className={`relative ${className}`}>
      <Slider.Root
        className="relative flex items-center h-5 w-full cursor-pointer group select-none touch-none"
        value={[volume]}
        max={200}
        step={1}
        onValueChange={([v]) => setVolume(v)}
        onKeyDown={(e) => {
          // Prevent slider from reacting to Left/Right, let event bubble to global binds
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') e.preventDefault();
        }}
        onWheel={(e) => {
          e.preventDefault();
          setVolume(Math.max(0, Math.min(200, volume + (e.deltaY < 0 ? 2 : -2))));
        }}
      >
        <Slider.Track className="relative h-[3px] grow rounded-full bg-white/[0.08] group-hover:h-[4px] transition-all duration-150">
          <Slider.Range
            className={`absolute h-full rounded-full ${isOver100 ? 'bg-amber-400/80' : 'bg-white/60'}`}
          />
        </Slider.Track>
        <Slider.Thumb
          className={`block w-2.5 h-2.5 rounded-full transition-all duration-150 outline-none scale-0 opacity-0 group-hover:scale-100 group-hover:opacity-100 ${isOver100 ? 'bg-amber-400' : 'bg-white'}`}
        />
      </Slider.Root>
      {/* 100% tick mark (visual only, outside Slider tree) */}
      <div
        className="absolute top-1/2 -translate-y-1/2 h-[3px] w-px bg-white/20 pointer-events-none"
        style={{ left: '50%' }}
      />
    </div>
  );
});

/* ── Volume button ───────────────────────────────────────────── */

const ControlVolumeBtn = React.memo(({ size = 'default' }: { size?: 'default' | 'sm' }) => {
  const volume = usePlayerStore((s) => s.volume);
  const volumeBeforeMute = usePlayerStore((s) => s.volumeBeforeMute);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const s = size === 'sm' ? 'w-9 h-9' : 'w-10 h-10';
  return (
    <button
      type="button"
      onClick={() => setVolume(volume > 0 ? 0 : volumeBeforeMute)}
      className={`${s} rounded-full flex items-center justify-center transition-all duration-150 ease-[var(--ease-apple)] cursor-pointer hover:bg-white/[0.04] ${
        volume === 0 ? 'text-accent' : 'text-white/40 hover:text-white/70'
      }`}
    >
      {volume === 0 ? volumeXIcon16 : volume < 50 ? volume1Icon16 : volume2Icon16}
    </button>
  );
});

/* ── Volume % label ──────────────────────────────────────────── */

const VolumeLabel = React.memo(() => {
  const volume = usePlayerStore((s) => s.volume);
  return (
    <span
      className={`text-[10px] tabular-nums w-[34px] text-right shrink-0 ${volume > 100 ? 'text-amber-400/70' : 'text-white/30'}`}
    >
      {volume}%
    </span>
  );
});

/* ── Progress Time (updates once per second) ─────────────────── */

export const ProgressTime = React.memo(() => {
  const currentSecond = useSyncExternalStore(subscribe, () => Math.floor(getCurrentTime()));
  const duration = useSyncExternalStore(subscribe, getDuration);

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-white/50 tabular-nums font-medium">
        {formatTime(currentSecond)}
      </span>
      <span className="text-[11px] text-white/20">/</span>
      <span className="text-[11px] text-white/30 tabular-nums font-medium">
        {formatTime(duration)}
      </span>
    </div>
  );
});

/* ── Like button ─────────────────────────────────────────────── */

function LikeButton({ trackUrn }: { trackUrn: string }) {
  const qc = useQueryClient();

  const { data: trackData } = useQuery({
    queryKey: ['track', trackUrn],
    queryFn: () => api<Track>(`/tracks/${encodeURIComponent(trackUrn)}`),
    enabled: !!trackUrn,
    staleTime: 30_000,
  });

  const [liked, setLiked] = useState<boolean | null>(null);
  const prevUrn = useRef(trackUrn);

  if (prevUrn.current !== trackUrn) {
    prevUrn.current = trackUrn;
    setLiked(null);
  }

  const isLiked = liked ?? trackData?.user_favorite ?? false;

  const toggle = async () => {
    const next = !isLiked;
    setLiked(next);
    if (trackData) optimisticToggleLike(qc, trackData, next);
    invalidateAllLikesCache();
    try {
      await api(`/likes/tracks/${encodeURIComponent(trackUrn)}`, {
        method: next ? 'POST' : 'DELETE',
      });
      qc.invalidateQueries({ queryKey: ['track', trackUrn, 'favoriters'] });
    } catch {
      setLiked(!next);
      if (trackData) optimisticToggleLike(qc, trackData, !next);
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition-all duration-200 cursor-pointer hover:bg-white/[0.04] ${
        isLiked ? 'text-accent' : 'text-white/30 hover:text-white/60'
      }`}
    >
      <Heart size={16} fill={isLiked ? 'currentColor' : 'none'} />
    </button>
  );
}

/* ── Dislike (Block) button ──────────────────────────────────── */

function DislikeButton({ trackUrn }: { trackUrn: string }) {
  const isDisliked = useDislikesStore((s) => s.dislikedTrackUrns.includes(trackUrn));
  const toggle = useDislikesStore((s) => s.toggleDislike);
  const next = usePlayerStore((s) => s.next);
  const { t } = useTranslation();

  const handleToggle = () => {
    toggle(trackUrn);
    if (!isDisliked) {
      const sw = useSoundWaveStore.getState();
      const currentTrack = usePlayerStore.getState().currentTrack;
      if (sw.isActive && currentTrack && currentTrack.urn === trackUrn) {
        sw.recordFeedback(currentTrack, 'negative');
      }
      next();
    }
  };

  return (
    <button
      type="button"
      onClick={handleToggle}
      title={t('track.dislike', "Don't play this track")}
      className={`w-9 h-9 flex items-center justify-center shrink-0 transition-all duration-200 cursor-pointer hover:bg-white/[0.04] ${
        isDisliked
          ? 'text-red-500 hover:text-red-400 opacity-100'
          : 'text-white/20 hover:text-red-400/80 opacity-0 group-hover/trackinfo:opacity-100'
      }`}
    >
      <Ban size={14} />
    </button>
  );
}

/* ── Mood correction button ──────────────────────────────────── */

const MOOD_OPTIONS: Array<{ mood: MoodLabel; key: string }> = [
  { mood: 'energetic', key: 'track.moodEnergetic' },
  { mood: 'happy', key: 'track.moodHappy' },
  { mood: 'calm', key: 'track.moodCalm' },
  { mood: 'sad', key: 'track.moodSad' },
];

function MoodCorrectionButton({ track }: { track: Track }) {
  const { t } = useTranslation();
  const trainTrackMood = useSoundWaveStore((s) => s.trainTrackMood);
  const initWave = useSoundWaveStore((s) => s.init);
  const [open, setOpen] = useState(false);
  const [pendingMood, setPendingMood] = useState<MoodLabel | null>(null);
  const [sending, setSending] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset local mood UI only on track switch
  useEffect(() => {
    setOpen(false);
    setPendingMood(null);
    setSending(false);
  }, [track.urn]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      const node = rootRef.current;
      if (!node) return;
      if (!node.contains(event.target as Node)) {
        setOpen(false);
        setPendingMood(null);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        setPendingMood(null);
      }
    };

    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const confirmMood = async () => {
    if (!pendingMood || sending) return;
    setSending(true);
    try {
      await initWave();
      trainTrackMood(track, pendingMood);
      setOpen(false);
      setPendingMood(null);
    } finally {
      setSending(false);
    }
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => {
          setOpen((value) => {
            const next = !value;
            if (!next) {
              setPendingMood(null);
            }
            return next;
          });
        }}
        title={t('track.moodCorrection', 'Correct mood')}
        className={`w-9 h-9 flex items-center justify-center transition-all duration-200 cursor-pointer hover:bg-white/[0.04] ${
          open
            ? 'text-accent opacity-100'
            : 'text-white/20 hover:text-accent opacity-0 group-hover/trackinfo:opacity-100'
        }`}
      >
        <Sparkles size={14} />
      </button>

      {open && (
        <div className="absolute left-full top-1/2 z-40 ml-2 w-[240px] -translate-y-1/2 rounded-2xl border border-white/10 bg-[#121214] p-3 shadow-2xl shadow-black/60">
          {!pendingMood ? (
            <div className="space-y-2">
              <p className="text-[11px] font-semibold text-white/50">
                {t('track.moodChoose', 'Choose the correct mood')}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {MOOD_OPTIONS.map((option) => (
                  <button
                    key={option.mood}
                    type="button"
                    onClick={() => setPendingMood(option.mood)}
                    className="rounded-xl border border-white/10 bg-white/[0.03] px-2.5 py-2 text-[11px] font-semibold text-white/80 transition-all hover:bg-white/[0.08] hover:text-white"
                  >
                    {t(option.key)}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-2.5">
              <p className="text-[11px] font-semibold text-white/80">
                {t('track.moodConfirmPrompt', {
                  mood: t(
                    MOOD_OPTIONS.find((option) => option.mood === pendingMood)?.key ||
                      'track.moodEnergetic',
                  ),
                })}
              </p>
              <p className="text-[10px] text-white/45">
                {t('track.moodConfirmHint', 'This will train SoundWave recommendations.')}
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={confirmMood}
                  disabled={sending}
                  className="flex-1 rounded-xl bg-accent px-2.5 py-2 text-[11px] font-semibold text-black transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {t('track.moodConfirmYes', 'Yes')}
                </button>
                <button
                  type="button"
                  onClick={() => setPendingMood(null)}
                  disabled={sending}
                  className="flex-1 rounded-xl border border-white/10 bg-white/[0.03] px-2.5 py-2 text-[11px] font-semibold text-white/70 transition-all hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {t('track.moodConfirmNo', 'No')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Isolated control buttons ────────────────────────────────── */

const btnClass = (active: boolean, size: 'default' | 'sm') =>
  `${size === 'sm' ? 'w-9 h-9' : 'w-10 h-10'} rounded-full flex items-center justify-center transition-all duration-150 ease-[var(--ease-apple)] cursor-pointer hover:bg-white/[0.04] ${
    active ? 'text-accent' : 'text-white/40 hover:text-white/70'
  }`;

const PlayPauseBtn = React.memo(() => {
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  return (
    <button
      type="button"
      onClick={togglePlay}
      className="w-12 h-12 rounded-full bg-white/90 flex items-center justify-center text-black hover:bg-white hover:scale-105 active:scale-95 transition-all duration-200 ease-[var(--ease-apple)] cursor-pointer mx-1.5"
    >
      {isPlaying ? pauseBlack20 : playBlack20}
    </button>
  );
});

const ShuffleBtn = React.memo(() => {
  const shuffle = usePlayerStore((s) => s.shuffle);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  return (
    <button type="button" onClick={toggleShuffle} className={btnClass(shuffle, 'sm')}>
      {shuffleIcon16}
    </button>
  );
});

const RepeatBtn = React.memo(() => {
  const repeat = usePlayerStore((s) => s.repeat);
  const toggleRepeat = usePlayerStore((s) => s.toggleRepeat);
  return (
    <button type="button" onClick={toggleRepeat} className={btnClass(repeat !== 'off', 'sm')}>
      {repeat === 'one' ? repeat1Icon16 : repeatIcon16}
    </button>
  );
});

const PrevBtn = React.memo(() => (
  <button type="button" onClick={handlePrev} className={btnClass(false, 'default')}>
    {skipBack20}
  </button>
));

const NextBtn = React.memo(() => {
  const next = usePlayerStore((s) => s.next);
  return (
    <button type="button" onClick={next} className={btnClass(false, 'default')}>
      {skipForward20}
    </button>
  );
});

const QueueBtn = React.memo(({ onClick, active }: { onClick: () => void; active: boolean }) => (
  <button type="button" onClick={onClick} className={btnClass(active, 'sm')}>
    {listMusic16}
  </button>
));

const LyricsBtn = React.memo(() => {
  const open = useLyricsStore((s) => s.open);
  const toggle = useLyricsStore((s) => s.toggle);
  return (
    <button type="button" onClick={toggle} className={btnClass(open, 'sm')}>
      <MicVocal size={16} />
    </button>
  );
});

const EqBtn = React.memo(() => {
  const eqEnabled = useSettingsStore((s) => s.eqEnabled);
  return (
    <EqualizerPanel>
      <button type="button" className={btnClass(eqEnabled, 'sm')}>
        {audioLines16}
      </button>
    </EqualizerPanel>
  );
});

/* ── Track Info (left section) ───────────────────────────────── */

const TrackInfo = React.memo(() => {
  const navigate = useNavigate();
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const artworkSmall = art(currentTrack?.artwork_url, 't200x200');

  if (!currentTrack) {
    return (
      <div className="flex items-center gap-3.5 w-[280px] min-w-0">
        <p className="text-[13px] text-white/15">Not playing</p>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3.5 w-[280px] min-w-0">
      <div
        className="relative w-14 h-14 rounded-[10px] shrink-0 overflow-hidden cursor-pointer shadow-xl shadow-black/40 ring-1 ring-white/[0.06] hover:ring-white/[0.12] transition-all duration-200 group/art"
        onClick={() => artworkPanelApi.open()}
      >
        {artworkSmall ? (
          <img src={artworkSmall} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full bg-white/[0.04]" />
        )}
        <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 group-hover/art:bg-black/40 group-hover/art:opacity-100 transition-all duration-200">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" className="text-white">
            <path
              d="M3 7V3h4M11 3h4v4M15 11v4h-4M7 15H3v-4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center">
          <StreamQualityBadge quality={currentTrack.streamQuality} access={currentTrack.access} />
        </div>
        <div className="flex items-center gap-1.5 min-w-0">
          <p
            className="text-[13px] text-white/90 truncate font-medium cursor-pointer hover:text-white leading-tight transition-colors"
            onClick={() => navigate(`/track/${encodeURIComponent(currentTrack.urn)}`)}
          >
            {currentTrack.title}
          </p>
          {currentTrack.access === 'preview' && (
            <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide bg-amber-500/20 text-amber-400/90 px-1.5 py-px rounded">
              Preview
            </span>
          )}
        </div>
        <p
          className="text-[11px] text-white/35 truncate mt-1 cursor-pointer hover:text-white/55 transition-colors"
          onClick={() => navigate(`/user/${encodeURIComponent(currentTrack.user.urn)}`)}
        >
          {currentTrack.user.username}
        </p>
      </div>
      <div className="flex items-center -mr-2">
        <LikeButton trackUrn={currentTrack.urn} />
        <DislikeButton trackUrn={currentTrack.urn} />
        <MoodCorrectionButton track={currentTrack} />
      </div>
    </div>
  );
});

/* ── Background glow ─────────────────────────────────────────── */

const BackgroundGlow = React.memo(() => {
  const artworkUrl = usePlayerStore((s) => s.currentTrack?.artwork_url);
  const artwork = art(artworkUrl, 't200x200');

  if (!artwork) return null;
  return (
    <div
      className="absolute inset-0 opacity-[0.05] blur-3xl pointer-events-none"
      style={{
        backgroundImage: `url(${artwork})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        contain: 'strict',
        transform: 'translateZ(0)',
      }}
    />
  );
});

/* ── Playbar Visualizer ──────────────────────────────────────── */

const PlaybarVisualizer = React.memo(() => {
  const w = useSettingsStore((s) => s.visualizerWidth);
  const h = useSettingsStore((s) => s.visualizerHeight);
  const op = useSettingsStore((s) => s.visualizerOpacity);
  const fade = useSettingsStore((s) => s.visualizerFade);

  return (
    <div
      className="absolute pointer-events-none z-[5] overflow-visible"
      style={{
        bottom: '100%',
        width: `${w}%`,
        height: `${h}px`,
        left: `${(100 - w) / 2}%`,
        opacity: op / 100,
        maskImage: `linear-gradient(to top, black ${100 - fade}%, transparent 100%)`,
        WebkitMaskImage: `linear-gradient(to top, black ${100 - fade}%, transparent 100%)`,
      }}
    >
      <Visualizer className="w-full h-full" />
    </div>
  );
});

/* ── Global Discord Lyrics Syncer ────────────────────────────── */

const DiscordLyricsSyncer = React.memo(() => {
  const currentTrack = usePlayerStore((s) => s.currentTrack);

  const { data: lyrics } = useQuery({
    queryKey: ['lyrics', currentTrack?.urn, currentTrack?.user.username, currentTrack?.title],
    queryFn: () => searchLyrics(currentTrack!.user.username, currentTrack!.title),
    enabled: !!currentTrack,
    staleTime: Number.POSITIVE_INFINITY,
  });

  useEffect(() => {
    if (!lyrics?.synced) {
      updateDiscordLyric(null);
      return;
    }

    const unsub = subscribe(() => {
      const t = getCurrentTime();
      let activeText: string | null = null;

      for (let i = lyrics.synced!.length - 1; i >= 0; i--) {
        if (t >= lyrics.synced![i].time) {
          activeText = lyrics.synced![i].text;
          break;
        }
      }

      updateDiscordLyric(activeText);
    });

    return unsub;
  }, [lyrics]);

  return null;
});

/* ── NowPlayingBar ───────────────────────────────────────────── */

export const NowPlayingBar = React.memo(
  ({ onQueueToggle, queueOpen }: { onQueueToggle: () => void; queueOpen: boolean }) => {
    const isMobile = useIsMobile();
    const isPlaying = usePlayerStore((s) => s.isPlaying);
    const togglePlay = usePlayerStore((s) => s.togglePlay);
    const lyricsOpen = useLyricsStore((s) => s.open);
    const artworkOpen = useArtworkStore((s) => s.open);
    const visualizerPlaybar = useSettingsStore((s) => s.visualizerPlaybar);
    const isFullscreenOverlayOpen = lyricsOpen || artworkOpen;

    return (
      <div className={`shrink-0 relative group/trackinfo ${isMobile ? 'h-[72px]' : ''}`}>
        <DiscordLyricsSyncer />
        {!isFullscreenOverlayOpen && <BackgroundGlow />}

        {visualizerPlaybar && !isMobile && !isFullscreenOverlayOpen && <PlaybarVisualizer />}

        <div className="relative z-10" style={{ isolation: 'isolate' }}>
          {!isMobile && <ProgressSlider />}
          <div
            className={`${isMobile ? 'h-[72px]' : 'h-[76px]'} flex items-center px-5 gap-3 relative`}
          >
            {/* Left: track info */}
            <div className="w-[320px] min-w-0">
              <TrackInfo />
            </div>

            {!isMobile ? (
              <>
                {/* Center: controls */}
                <div className="absolute left-1/2 -translate-x-1/2 flex flex-col items-center gap-0.5">
                  <div className="flex items-center gap-0.5">
                    <ShuffleBtn />
                    <PrevBtn />
                    <PlayPauseBtn />
                    <NextBtn />
                    <RepeatBtn />
                  </div>
                  <ProgressTime />
                </div>

                {/* Right: volume + queue */}
                <div className="ml-auto flex items-center gap-0.5 w-[320px] justify-end">
                  <EqBtn />
                  <LyricsBtn />
                  <QueueBtn onClick={onQueueToggle} active={queueOpen} />
                  <ControlVolumeBtn size="sm" />
                  <VolumeSlider className="w-[100px]" />
                  <VolumeLabel />
                </div>
              </>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePlay();
                  }}
                  className="w-10 h-10 rounded-full bg-white flex items-center justify-center text-black"
                >
                  {isPlaying ? pauseBlack20 : playBlack20}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  },
);
