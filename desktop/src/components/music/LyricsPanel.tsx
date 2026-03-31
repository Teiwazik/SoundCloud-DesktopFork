import * as Slider from '@radix-ui/react-slider';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { getCurrentTime, handlePrev, seek } from '../../lib/audio';
import { art } from '../../lib/formatters';
import { invalidateAllLikesCache } from '../../lib/hooks';
import {
  Ban,
  ExternalLink,
  Eye,
  Heart,
  ListPlus,
  Loader2,
  Maximize2,
  MicVocal,
  pauseBlack18,
  playBlack18,
  repeat1Icon16,
  repeatIcon16,
  Search,
  SkipBack,
  SkipForward,
  shuffleIcon16,
  volume1Icon16,
  volume2Icon16,
  volumeXIcon16,
  X,
} from '../../lib/icons';
import { optimisticToggleLike, useLiked } from '../../lib/likes';
import type { LyricLine, LyricsSource } from '../../lib/lyrics';
import { searchLyrics, splitArtistTitle } from '../../lib/lyrics';
import { useDislikesStore } from '../../stores/dislikes';
import { useArtworkStore, useLyricsStore } from '../../stores/lyrics';
import { type Track, usePlayerStore } from '../../stores/player';
import { useSettingsStore } from '../../stores/settings';
import { useSoundWaveStore } from '../../stores/soundwave';
import { ProgressSlider, ProgressTime } from '../layout/NowPlayingBar';
import { AddToPlaylistDialog } from './AddToPlaylistDialog';
import { FloatingComments } from './FloatingComments';
import { StreamQualityBadge } from './StreamQualityBadge';
import { Visualizer } from './Visualizer';

/* ── Source Badge ─────────────────────────────────────────── */

const SOURCE_LABELS: Record<LyricsSource, string> = {
  lrclib: 'LRCLib',
  netease: 'NetEase',
  musixmatch: 'Musixmatch',
  genius: 'Genius',
  textyl: 'Textyl',
};

const resolveTrackPermalink = async (track: Track): Promise<string | null> => {
  const direct = track.permalink_url?.trim();
  if (direct) return direct;

  try {
    const refreshed = await api<Pick<Track, 'permalink_url'>>(
      `/tracks/${encodeURIComponent(track.urn)}`,
      { quietHttpErrors: true },
    );
    const refreshedPermalink = refreshed.permalink_url?.trim();
    if (refreshedPermalink) return refreshedPermalink;
  } catch {
    // noop
  }

  if (track.id > 0) {
    return `https://soundcloud.com/tracks/${track.id}`;
  }

  return null;
};

const openExternal = async (url: string) => {
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
};

const LyricsSourceBadge = React.memo(
  ({ source, onSearch }: { source: LyricsSource; onSearch?: () => void }) => (
    <div className="flex items-center justify-between px-12 pt-3 pb-0">
      <span className="text-[10px] font-semibold text-white/20 bg-white/[0.04] px-2 py-0.5 rounded-full border border-white/[0.06]">
        {SOURCE_LABELS[source]}
      </span>
      {onSearch && (
        <button
          type="button"
          onClick={onSearch}
          className="w-8 h-8 flex items-center justify-center rounded-full text-white/30 hover:text-white/70 hover:bg-white/10 transition-colors"
        >
          <Search size={14} />
        </button>
      )}
    </div>
  ),
);

/* ── Color extraction ─────────────────────────────────────── */

function extractColor(src: string): Promise<[number, number, number]> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 10;
        c.height = 10;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(img, 0, 0, 10, 10);
        const d = ctx.getImageData(0, 0, 10, 10).data;
        let r = 0,
          g = 0,
          b = 0;
        const n = d.length / 4;
        for (let i = 0; i < d.length; i += 4) {
          r += d[i];
          g += d[i + 1];
          b += d[i + 2];
        }
        resolve([Math.round(r / n), Math.round(g / n), Math.round(b / n)]);
      } catch {
        resolve([255, 85, 0]);
      }
    };
    img.onerror = () => resolve([255, 85, 0]);
    img.src = src;
  });
}

/* ── Shared: dynamic background ───────────────────────────── */

const FullscreenBackground = React.memo(
  ({ artworkSrc, color }: { artworkSrc: string | null; color: [number, number, number] }) => {
    const [r, g, b] = color;
    const visualizerFullscreen = useSettingsStore((s) => s.visualizerFullscreen);
    return (
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ contain: 'strict', transform: 'translateZ(0)' }}
      >
        {artworkSrc && (
          <img
            src={artworkSrc}
            alt=""
            className="w-full h-full object-cover scale-[1.2] blur-[72px] opacity-20 saturate-[1.3]"
            loading="eager"
            decoding="async"
          />
        )}
        <div
          className="absolute inset-0"
          style={{
            background: `
              radial-gradient(ellipse at 25% 50%, rgba(${r},${g},${b},0.2) 0%, transparent 60%),
              radial-gradient(ellipse at 75% 70%, rgba(${r},${g},${b},0.12) 0%, transparent 50%)
            `,
          }}
        />
        {visualizerFullscreen && <FullscreenVisualizer />}
      </div>
    );
  },
);

/* ── Fullscreen Visualizer ────────────────────────────────── */

const FullscreenVisualizer = React.memo(() => {
  const w = useSettingsStore((s) => s.visualizerWidth);
  const op = useSettingsStore((s) => s.visualizerOpacity);
  const fade = useSettingsStore((s) => s.visualizerFade);
  const sc = useSettingsStore((s) => s.visualizerScale) / 100;

  return (
    <div
      className="absolute bottom-0 left-0 right-0 z-[1] pointer-events-none mix-blend-screen"
      style={{
        width: `${w}%`,
        height: '50%',
        minHeight: '350px',
        left: `${(100 - w) / 2}%`,
        opacity: op / 100,
        transform: `scaleY(${sc})`,
        transformOrigin: 'bottom center',
        maskImage: `linear-gradient(to top, black ${100 - fade}%, transparent 100%)`,
        WebkitMaskImage: `linear-gradient(to top, black ${100 - fade}%, transparent 100%)`,
      }}
    >
      <Visualizer className="w-full h-full" />
    </div>
  );
});

/* ── Shared: like button (for fullscreen panels) ──────────── */

const FullscreenLikeButton = React.memo(({ track }: { track: Track }) => {
  const likedFromStore = useLiked(track.urn);
  const qc = useQueryClient();
  const { data: trackData } = useQuery({
    queryKey: ['track', track.urn],
    queryFn: () => api<Track>(`/tracks/${encodeURIComponent(track.urn)}`),
    enabled: !!track.urn,
    staleTime: 30_000,
  });
  const [likedOverride, setLikedOverride] = useState<boolean | null>(null);
  const prevUrnRef = useRef(track.urn);

  if (prevUrnRef.current !== track.urn) {
    prevUrnRef.current = track.urn;
    setLikedOverride(null);
  }

  const isLiked =
    likedOverride ??
    (trackData
      ? Boolean(trackData.user_favorite)
      : likedFromStore || Boolean(track.user_favorite));

  const toggle = async () => {
    const next = !isLiked;
    setLikedOverride(next);
    optimisticToggleLike(qc, trackData ?? track, next);
    invalidateAllLikesCache();
    try {
      await api(`/likes/tracks/${encodeURIComponent(track.urn)}`, {
        method: next ? 'POST' : 'DELETE',
      });
      qc.invalidateQueries({ queryKey: ['track', track.urn, 'favoriters'] });
    } catch {
      setLikedOverride(!next);
      optimisticToggleLike(qc, trackData ?? track, !next);
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className={`w-11 h-11 rounded-full flex items-center justify-center transition-all duration-200 cursor-pointer hover:bg-white/[0.06] outline-none ${
        isLiked ? 'text-accent' : 'text-white/30 hover:text-white/60'
      }`}
    >
      <Heart size={20} fill={isLiked ? 'currentColor' : 'none'} />
    </button>
  );
});

/* ── Shared: dislike button (for fullscreen panels) ────────── */

const FullscreenDislikeButton = React.memo(({ track }: { track: Track }) => {
  const trackUrn = track.urn;
  const isDisliked = useDislikesStore((s) => s.dislikedTrackUrns.includes(trackUrn));
  const toggle = useDislikesStore((s) => s.toggleDislike);
  const next = usePlayerStore((s) => s.next);

  const handleToggle = () => {
    toggle(trackUrn);
    if (!isDisliked) {
      const sw = useSoundWaveStore.getState();
      if (sw.isActive) {
        sw.recordFeedback(track, 'negative');
      }
      next();
    }
  };

  return (
    <button
      type="button"
      onClick={handleToggle}
      className={`w-11 h-11 rounded-full flex items-center justify-center transition-all duration-200 cursor-pointer hover:bg-white/[0.06] outline-none ${
        isDisliked ? 'text-red-500' : 'text-white/30 hover:text-white/60'
      }`}
    >
      <Ban size={18} />
    </button>
  );
});

/* ── Shared: volume slider (for fullscreen panels) ─────────── */

const FullscreenVolumeSlider = React.memo(() => {
  const volume = usePlayerStore((s) => s.volume);
  const volumeBeforeMute = usePlayerStore((s) => s.volumeBeforeMute);
  const setVolume = usePlayerStore((s) => s.setVolume);

  return (
    <div className="flex items-center gap-3 w-full max-w-[280px] mt-2 group/vol">
      <button
        type="button"
        onClick={() => setVolume(volume > 0 ? 0 : volumeBeforeMute)}
        className="w-8 h-8 rounded-full flex items-center justify-center text-white/30 hover:text-white/60 hover:bg-white/5 transition-all outline-none"
      >
        {volume === 0 ? volumeXIcon16 : volume < 50 ? volume1Icon16 : volume2Icon16}
      </button>
      <div className="flex-1 relative flex items-center h-5">
        <Slider.Root
          className="relative flex items-center h-full w-full cursor-pointer select-none touch-none"
          value={[volume]}
          max={200}
          step={1}
          onValueChange={([v]) => setVolume(v)}
        >
          <Slider.Track className="relative h-[3px] grow rounded-full bg-white/[0.08] group-hover/vol:h-[4px] transition-all duration-150">
            <Slider.Range
              className={`absolute h-full rounded-full ${volume > 100 ? 'bg-accent' : 'bg-white/40'}`}
            />
          </Slider.Track>
          <Slider.Thumb
            className={`block w-2.5 h-2.5 rounded-full transition-all duration-150 outline-none scale-0 opacity-0 group-hover/vol:scale-100 group-hover/vol:opacity-100 ${volume > 100 ? 'bg-accent shadow-[0_0_10px_var(--color-accent-glow)]' : 'bg-white'}`}
          />
        </Slider.Root>
      </div>
      <span className={`text-[10px] tabular-nums w-8 text-right font-medium ${volume > 100 ? 'text-accent/90' : 'text-white/20'}`}>
        {volume}%
      </span>
    </div>
  );
});

/* ── Shared: transport controls + like ────────────────────── */

const Controls = React.memo(({ track }: { track: Track }) => {
  const { t } = useTranslation();
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const next = usePlayerStore((s) => s.next);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const repeat = usePlayerStore((s) => s.repeat);
  const toggleRepeat = usePlayerStore((s) => s.toggleRepeat);

  const ctrl =
    'w-11 h-11 rounded-full flex items-center justify-center transition-all duration-150 cursor-pointer hover:bg-white/[0.06] outline-none';

  const handleOpenInSoundCloud = () => {
    void (async () => {
      const permalink = await resolveTrackPermalink(track);
      if (!permalink) return;
      await openExternal(permalink);
    })();
  };

  return (
    <div className="flex items-center justify-center gap-2">
      <AddToPlaylistDialog trackUrn={track.urn}>
        <button type="button" className={ctrl}>
          <ListPlus size={20} className="text-white/30 hover:text-white/60" />
        </button>
      </AddToPlaylistDialog>
      <FullscreenLikeButton track={track} />
      <button
        type="button"
        onClick={toggleShuffle}
        className={`${ctrl} ${shuffle ? 'text-accent' : 'text-white/35 hover:text-white/60'}`}
      >
        {shuffleIcon16}
      </button>
      <button
        type="button"
        onClick={handlePrev}
        className={`${ctrl} text-white/60 hover:text-white`}
      >
        <SkipBack size={20} fill="currentColor" />
      </button>

      <button
        type="button"
        onClick={togglePlay}
        className="w-14 h-14 rounded-full bg-white flex items-center justify-center hover:scale-105 active:scale-95 transition-all duration-200 cursor-pointer shadow-lg outline-none mx-1"
      >
        {isPlaying ? pauseBlack18 : playBlack18}
      </button>

      <button type="button" onClick={next} className={`${ctrl} text-white/60 hover:text-white`}>
        <SkipForward size={20} fill="currentColor" />
      </button>
      <button
        type="button"
        onClick={toggleRepeat}
        className={`${ctrl} ${repeat !== 'off' ? 'text-accent' : 'text-white/35 hover:text-white/60'}`}
      >
        {repeat === 'one' ? repeat1Icon16 : repeatIcon16}
      </button>
      <FullscreenDislikeButton track={track} />
      <button
        type="button"
        className={ctrl}
        onClick={handleOpenInSoundCloud}
        title={t('player.openInSoundCloud', 'Open in SoundCloud')}
      >
        <ExternalLink size={18} className="text-white/30 hover:text-white/60" />
      </button>
    </div>
  );
});

/* ── Shared: artwork + info + slider + controls column ────── */

const TrackColumn = React.memo(({ track, maxArt }: { track: Track; maxArt?: string }) => {
  const artwork500 = art(track.artwork_url, 't500x500');
  const artworkOriginal = artwork500 ? artwork500.replace('t500x500', 'original') : null;
  const artwork200 = art(track.artwork_url, 't200x200');
  const [loaded, setLoaded] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [showFullArt, setShowFullArt] = useState(false);
  const prevUrnRef = useRef<string | null>(track.urn);
  const mountedRef = useRef(false);
  const switchTimerRef = useRef<number | null>(null);

  const clearSwitching = () => {
    if (switchTimerRef.current !== null) {
      window.clearTimeout(switchTimerRef.current);
      switchTimerRef.current = null;
    }
    setIsSwitching(false);
  };

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }

    if (prevUrnRef.current !== track.urn) {
      prevUrnRef.current = track.urn;
      setLoaded(false);
      setShowFullArt(false);

      const shouldBlurTransition = Boolean(artwork200 && artwork500 && artwork200 !== artwork500);
      setIsSwitching(shouldBlurTransition);

      if (shouldBlurTransition) {
        if (switchTimerRef.current !== null) {
          window.clearTimeout(switchTimerRef.current);
        }
        switchTimerRef.current = window.setTimeout(() => {
          setIsSwitching(false);
          switchTimerRef.current = null;
        }, 900);
      }
    }
  }, [track.urn, artwork200, artwork500]);

  useEffect(() => {
    return () => {
      if (switchTimerRef.current !== null) {
        window.clearTimeout(switchTimerRef.current);
      }
    };
  }, []);

  return (
    <div className="flex flex-col items-center justify-center gap-5 px-12">
      <div
        className={`w-full ${maxArt ?? 'max-w-[360px]'} aspect-square rounded-2xl overflow-hidden shadow-2xl shadow-black/60 ring-1 ring-white/[0.08] relative group/art`}
      >
        {artwork500 ? (
          <>
            {/* Low-res placeholder (Blur applied only during track switch) */}
            <img
              src={artwork200 || artwork500}
              alt=""
              className={`absolute inset-0 w-full h-full object-cover scale-110 transition-all duration-700 ease-[var(--ease-apple)] ${
                isSwitching ? 'blur-2xl scale-125' : ''
              } ${loaded ? 'opacity-0' : 'opacity-100'}`}
            />
            {/* High-res image */}
            <img
              src={artwork500}
              alt=""
              onLoad={() => {
                setLoaded(true);
                clearSwitching();
              }}
              onError={() => {
                clearSwitching();
              }}
              className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-700 ease-[var(--ease-apple)] ${loaded ? 'opacity-100' : 'opacity-0'}`}
            />

            {/* Hover Overlay with View Icon */}
            <button
              type="button"
              onClick={() => setShowFullArt(true)}
              className="absolute inset-0 bg-black/40 opacity-0 group-hover/art:opacity-100 transition-opacity duration-300 flex items-center justify-center text-white/90 backdrop-blur-[2px] cursor-pointer outline-none"
            >
              <div className="flex flex-col items-center gap-2 scale-90 group-hover/art:scale-100 transition-transform duration-300">
                <div className="w-12 h-12 rounded-full bg-white/20 flex items-center justify-center border border-white/20">
                  <Eye size={24} />
                </div>
                <span className="text-[11px] font-bold tracking-wider uppercase opacity-60">Просмотр</span>
              </div>
            </button>
          </>
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-white/[0.06] to-white/[0.02] flex items-center justify-center">
            <MicVocal size={48} className="text-white/10" />
          </div>
        )}
      </div>

      {/* Full-screen Image Modal */}
      {showFullArt && artworkOriginal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-8 sm:p-12 animate-fade-in bg-black/90 backdrop-blur-xl">
          <div
            className="absolute inset-0 cursor-pointer"
            onClick={() => setShowFullArt(false)}
          />
          <button
            type="button"
            onClick={() => setShowFullArt(false)}
            className="absolute top-6 right-6 w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-all z-10 border border-white/10"
          >
            <X size={20} />
          </button>
          <img
            src={artworkOriginal}
            alt={track.title}
            className="relative z-10 max-w-full max-h-full rounded-2xl shadow-[0_32px_128px_rgba(0,0,0,0.8)] animate-zoom-in object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <div className="absolute bottom-8 left-0 right-0 text-center z-10 pointer-events-none px-6">
            <p className="text-white/90 font-bold text-lg drop-shadow-lg">{track.title}</p>
            <p className="text-white/40 text-sm drop-shadow-md">{track.user.username}</p>
          </div>
        </div>
      )}

      <div className={`w-full ${maxArt ?? 'max-w-[360px]'} text-center space-y-1`}>
        <p className="text-[18px] font-bold text-white/95 truncate">{track.title}</p>
        <p className="text-[14px] text-white/40 truncate">{track.user.username}</p>
      </div>

      <div className={`w-full ${maxArt ?? 'max-w-[360px]'}`}>
        <ProgressSlider />
        <div className="flex justify-center mt-1">
          <ProgressTime />
        </div>
      </div>

      <Controls track={track} />

      <FullscreenVolumeSlider />
    </div>
  );
});

/* ── Shared: color hook ───────────────────────────────────── */

function useArtworkColor(artworkUrl: string | null) {
  const colorRef = useRef<[number, number, number]>([255, 85, 0]);
  const prevArtRef = useRef<string | null>(null);

  useEffect(() => {
    const src = art(artworkUrl, 't200x200');
    if (!src || src === prevArtRef.current) return;
    prevArtRef.current = src;
    extractColor(src).then((c) => {
      colorRef.current = c;
    });
  }, [artworkUrl]);

  return colorRef;
}

/* ── Synced Lyrics ─ CSS data-state + DOM scroll, 0 re-renders */

const SyncedLyrics = React.memo(({ lines }: { lines: LyricLine[] }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(-1);
  const lastScrollTsRef = useRef(0);
  const manualScrollDetachedRef = useRef(false);
  const linesRef = useRef(lines);
  const lineElsRef = useRef<HTMLElement[]>([]);
  linesRef.current = lines;

  const findActiveIndex = (source: LyricLine[], time: number): number => {
    let lo = 0;
    let hi = source.length - 1;
    let ans = -1;

    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (source[mid].time <= time + 0.3) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    return ans;
  };

  const updateLineProgress = (idx: number, time: number) => {
    const lineEls = lineElsRef.current;
    const current = lineEls[idx];
    if (!current) return;

    const currentLine = linesRef.current[idx];
    const nextLine = linesRef.current[idx + 1];
    const duration = Math.max((nextLine?.time ?? currentLine.time + 2.4) - currentLine.time, 0.35);
    const progress = Math.max(0, Math.min((time - currentLine.time) / duration, 1));
    const activeChars = current.querySelectorAll<HTMLElement>('[data-char-index]');
    const activeCount = Math.floor(progress * activeChars.length + 0.0001);

    current.style.setProperty('--lyric-progress', `${progress * 100}%`);
    current.style.setProperty('--lyric-progress-value', `${progress}`);

    activeChars.forEach((charEl, charIndex) => {
      charEl.dataset.charState = charIndex < activeCount ? 'active' : '';
    });
  };

  const applyStates = (idx: number, _prev: number) => {
    const lineEls = lineElsRef.current;
    
    for (let i = 0; i < lineEls.length; i++) {
      const el = lineEls[i];
      if (!el) continue;

      let state = '';
      let progress = '0%';
      if (i === idx) {
        state = 'active';
      } else if (i < idx) {
        state = idx - i === 1 ? 'past-near' : 'past';
        progress = '100%';
      } else if (i > idx) {
        state = i - idx === 1 ? 'next-near' : 'next';
      }

      const stateChanged = el.dataset.state !== state;
      if (stateChanged) {
        el.dataset.state = state;
      }
      
      const progressChanged = el.style.getPropertyValue('--lyric-progress') !== progress;
      if (progressChanged) {
        el.style.setProperty('--lyric-progress', progress);
      }
      
      if (state !== 'active' && (stateChanged || progressChanged)) {
        el.style.setProperty('--lyric-progress-value', progress === '100%' ? '1' : '0');
        el.querySelectorAll<HTMLElement>('[data-char-index]').forEach((charEl) => {
          charEl.dataset.charState = progress === '100%' ? 'active' : '';
        });
      }
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: lines triggers DOM re-cache
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    lineElsRef.current = Array.from(container.querySelectorAll<HTMLElement>('.lyric-line'));

    const markManualScroll = () => {
      manualScrollDetachedRef.current = true;
    };

    container.addEventListener('wheel', markManualScroll, { passive: true });
    container.addEventListener('touchstart', markManualScroll, { passive: true });
    container.addEventListener('pointerdown', markManualScroll);

    activeRef.current = -1;
    manualScrollDetachedRef.current = false;

    const timerId = setInterval(() => {
      const lineEls = lineElsRef.current;
      if (!container || lineEls.length === 0) return;

      const time = getCurrentTime();
      const currentLines = linesRef.current;

      const idx = findActiveIndex(currentLines, time);
      const prev = activeRef.current;
      if (idx !== activeRef.current) {
        activeRef.current = idx;

        if (idx >= 0 && idx < lineEls.length) {
          const el = lineEls[idx];
          const top = el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2;
          const now = performance.now();
          if (!manualScrollDetachedRef.current) {
            if (now - lastScrollTsRef.current < 220 || prev === -1 || Math.abs(idx - prev) > 2) {
              container.scrollTo({ top, behavior: 'auto' });
            } else {
              container.scrollTo({ top, behavior: 'smooth' });
            }
            lastScrollTsRef.current = now;
          }
        }

        if (idx !== -1) {
          applyStates(idx, prev);
        }
      }

      if (idx !== -1) {
        updateLineProgress(idx, time);
      }
    }, 50);

    return () => {
      clearInterval(timerId);
      container.removeEventListener('wheel', markManualScroll);
      container.removeEventListener('touchstart', markManualScroll);
      container.removeEventListener('pointerdown', markManualScroll);
    };
  }, [lines]);

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto scrollbar-hide px-12 py-16 relative">
      <div className="flex flex-col gap-2">
        {lines.map((line, i) => (
          <div
            key={`${line.time}-${i}`}
            className="lyric-line group relative cursor-pointer origin-left transition-all duration-500 ease-[var(--ease-apple)] will-change-transform py-2.5 pr-12 text-[28px] font-bold tracking-tight antialiased text-white/22 opacity-40 scale-[0.972] translate-x-0 data-[state=active]:opacity-100 data-[state=active]:scale-[1.02] data-[state=active]:translate-x-0 data-[state=past-near]:opacity-78 data-[state=past-near]:scale-[0.992] data-[state=past-near]:-translate-x-1 data-[state=past]:opacity-48 data-[state=past]:scale-[0.98] data-[state=past]:-translate-x-2 data-[state=next-near]:opacity-66 data-[state=next-near]:scale-[0.988] data-[state=next-near]:translate-x-1.5 data-[state=next]:opacity-28 data-[state=next]:scale-[0.968] data-[state=next]:translate-x-3"
            style={{ textRendering: 'optimizeLegibility', ['--lyric-progress' as string]: '0%' }}
            onClick={() => {
              manualScrollDetachedRef.current = false;
              
              if (i === activeRef.current) {
                const container = containerRef.current;
                const el = lineElsRef.current[i];
                if (container && el) {
                  const top = el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2;
                  container.scrollTo({ top, behavior: 'smooth' });
                }
              } else {
                seek(line.time);
              }
            }}
          >
            <span className="block transition-[filter] duration-300 [filter:drop-shadow(0_0_10px_rgba(255,255,255,0.2))] group-data-[state=active]:[filter:drop-shadow(0_0_18px_rgba(255,255,255,0.38))]">
              {line.text.split(/(\s+)/).map((word, wordIdx, arr) => {
                const offset = arr.slice(0, wordIdx).join('').length;
                return (
                  <span key={wordIdx} className="inline-block whitespace-pre-wrap">
                    {Array.from(word).map((char, charIndex) => {
                      const globalIdx = offset + charIndex;
                      return (
                        <span
                          key={globalIdx}
                          data-char-index={globalIdx}
                          className="inline-block transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] text-white/30 data-[char-state=active]:text-white data-[char-state=active]:-translate-y-[0.16em] data-[char-state=active]:scale-[1.06] data-[char-state=active]:drop-shadow-[0_0_10px_rgba(255,255,255,0.38)]"
                        >
                          {char}
                        </span>
                      );
                    })}
                  </span>
                );
              })}
            </span>
          </div>
        ))}
      </div>
      <div className="h-[50vh]" />
    </div>
  );
});

/* ── Plain Lyrics ─────────────────────────────────────────── */

const PlainLyrics = React.memo(({ text }: { text: string }) => (
  <div
    className="flex-1 overflow-y-auto scrollbar-hide px-12 py-16"
    style={{ maskImage: 'linear-gradient(transparent 0%, black 10%, black 90%, transparent 100%)' }}
  >
    <div className="text-[18px] text-white/60 font-medium whitespace-pre-wrap leading-loose">
      {text}
    </div>
  </div>
));

/* ── Lyrics Panel (fullscreen, 50/50) ─────────────────────── */

export const LyricsPanel = React.memo(() => {
  const open = useLyricsStore((s) => s.open);
  const close = useLyricsStore((s) => s.close);
  const track = usePlayerStore((s) => s.currentTrack);
  const { t } = useTranslation();
  const colorRef = useArtworkColor(track?.artwork_url ?? null);

  const [isEditing, setIsEditing] = useState(false);
  const [manualQuery, setManualQuery] = useState<{ artist: string; title: string } | null>(null);
  const [editArtist, setEditArtist] = useState('');
  const [editTitle, setEditTitle] = useState('');

  const reqArtist = manualQuery ? manualQuery.artist : (track?.user.username ?? '');
  const reqTitle = manualQuery ? manualQuery.title : (track?.title ?? '');

  const { data: lyrics, isLoading } = useQuery({
    queryKey: ['lyrics', track?.urn, reqArtist, reqTitle],
    queryFn: () => searchLyrics(track!.urn, reqArtist, reqTitle),
    enabled: open && !!track,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset editor state only on track switch
  useEffect(() => {
    setManualQuery(null);
    setIsEditing(false);
  }, [track?.urn]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, close]);

  if (!open || !track) return null;

  const artwork500 = art(track.artwork_url, 't500x500');

  return (
    <div className="fixed inset-0 z-[60] flex flex-col overflow-hidden animate-fade-in-up bg-[#08080a]">
      <FullscreenBackground artworkSrc={artwork500} color={colorRef.current} />

      <div className="absolute top-6 left-6 z-20 pointer-events-none">
        <StreamQualityBadge
          quality={track.streamQuality}
          codec={track.streamCodec}
          access={track.access}
          className="backdrop-blur-sm"
        />
      </div>

      {/* Close */}
      <div className="relative z-10 flex justify-end items-center gap-2 px-6 pt-5 pb-2" data-tauri-drag-region>
        <button
          type="button"
          onClick={() => {
            close();
            useArtworkStore.getState().setOpen(true);
          }}
          className="h-9 rounded-full px-3 inline-flex items-center gap-1.5 text-[12px] font-semibold text-white/45 hover:text-white/80 hover:bg-white/[0.08] transition-all duration-200 cursor-pointer outline-none"
        >
          <Maximize2 size={14} />
          <span>{t('nav.fullscreen', 'Fullscreen')}</span>
        </button>
        <button
          type="button"
          onClick={close}
          className="w-9 h-9 rounded-full flex items-center justify-center text-white/25 hover:text-white/70 hover:bg-white/[0.08] transition-all duration-200 cursor-pointer outline-none"
        >
          <X size={18} />
        </button>
      </div>

      {/* 50/50 */}
      <div
        className="relative z-10 grid grid-cols-2 flex-1 min-h-0"
        style={{ isolation: 'isolate' }}
      >
        <TrackColumn track={track} />

        {/* Divider */}
        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-white/[0.04]" />

        {/* Right: lyrics */}
        <div className="min-h-0 flex flex-col relative">
          {isEditing ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 px-12 animate-fade-in-up">
              <h3 className="text-white/80 font-bold mb-2">
                {t('track.manualSearch', 'Manual Search')}
              </h3>
              <input
                value={editArtist}
                onChange={(e) => setEditArtist(e.target.value)}
                placeholder="Artist"
                className="w-full max-w-[280px] bg-white/10 px-4 py-2.5 rounded-xl text-white text-[14px] outline-none border border-transparent focus:border-white/20 placeholder:text-white/30"
              />
              <input
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                placeholder="Title"
                className="w-full max-w-[280px] bg-white/10 px-4 py-2.5 rounded-xl text-white text-[14px] outline-none border border-transparent focus:border-white/20 placeholder:text-white/30"
              />
              <div className="flex gap-3 mt-4">
                <button
                  type="button"
                  onClick={() => setIsEditing(false)}
                  className="px-5 py-2 rounded-full text-[13px] font-medium text-white/50 hover:text-white hover:bg-white/10 transition-colors"
                >
                  {t('common.back')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setManualQuery({ artist: editArtist, title: editTitle });
                    setIsEditing(false);
                  }}
                  className="px-6 py-2 rounded-full text-[13px] font-bold bg-white/20 hover:bg-white/30 text-white transition-colors"
                >
                  {t('track.search', 'Search')}
                </button>
              </div>
            </div>
          ) : isLoading ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3">
              <Loader2 size={24} className="animate-spin text-white/15" />
              <p className="text-[13px] text-white/25">{t('track.lyricsLoading')}</p>
            </div>
          ) : lyrics?.synced ? (
            <>
              <LyricsSourceBadge
                source={lyrics.source}
                onSearch={() => {
                  const parsed = splitArtistTitle(track?.title ?? '');
                  setEditArtist(
                    manualQuery?.artist || (parsed ? parsed[0] : track?.user.username || ''),
                  );
                  setEditTitle(manualQuery?.title || (parsed ? parsed[1] : track?.title || ''));
                  setIsEditing(true);
                }}
              />
              <SyncedLyrics lines={lyrics.synced} />
            </>
          ) : lyrics?.plain ? (
            <>
              <LyricsSourceBadge
                source={lyrics.source}
                onSearch={() => {
                  const parsed = splitArtistTitle(track?.title ?? '');
                  setEditArtist(
                    manualQuery?.artist || (parsed ? parsed[0] : track?.user.username || ''),
                  );
                  setEditTitle(manualQuery?.title || (parsed ? parsed[1] : track?.title || ''));
                  setIsEditing(true);
                }}
              />
              <PlainLyrics text={lyrics.plain} />
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 px-12 text-center relative">
              <button
                type="button"
                onClick={() => {
                  const parsed = splitArtistTitle(track?.title ?? '');
                  setEditArtist(
                    manualQuery?.artist || (parsed ? parsed[0] : track?.user.username || ''),
                  );
                  setEditTitle(manualQuery?.title || (parsed ? parsed[1] : track?.title || ''));
                  setIsEditing(true);
                }}
                className="absolute right-0 top-3 w-8 h-8 flex items-center justify-center rounded-full text-white/30 hover:text-white/70 hover:bg-white/10 transition-colors"
              >
                <Search size={14} />
              </button>
              <MicVocal size={40} className="text-white/[0.06]" />
              <p className="text-[15px] text-white/30 font-medium">{t('track.lyricsNotFound')}</p>
              <p className="text-[12px] text-white/15 leading-relaxed max-w-[300px]">
                {t('track.lyricsNotFoundHint')}
              </p>
            </div>
          )}
        </div>
      </div>

      <FloatingComments />
    </div>
  );
});

/* ── Artwork Fullscreen Panel ─────────────────────────────── */

export const ArtworkPanel = React.memo(() => {
  const { t } = useTranslation();
  const open = useArtworkStore((s) => s.open);
  const setOpen = useArtworkStore((s) => s.setOpen);
  const openLyrics = useLyricsStore((s) => s.openPanel);
  const track = usePlayerStore((s) => s.currentTrack);
  const colorRef = useArtworkColor(track?.artwork_url ?? null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, setOpen]);

  // Expose open/close
  useEffect(() => {
    artworkPanelApi.open = () => useArtworkStore.getState().setOpen(true);
    artworkPanelApi.close = () => useArtworkStore.getState().setOpen(false);
  }, []);

  if (!open || !track) return null;

  const artwork500 = art(track.artwork_url, 't500x500');

  return (
    <div className="fixed inset-0 z-[60] flex flex-col overflow-hidden animate-fade-in-up bg-[#08080a]">
      <FullscreenBackground artworkSrc={artwork500} color={colorRef.current} />

      <div className="absolute top-6 left-6 z-20 pointer-events-none">
        <StreamQualityBadge
          quality={track.streamQuality}
          codec={track.streamCodec}
          access={track.access}
          className="backdrop-blur-sm"
        />
      </div>

      {/* Close */}
      <div className="relative z-10 flex justify-end items-center gap-2 px-6 pt-5 pb-2" data-tauri-drag-region>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            openLyrics();
          }}
          className="h-9 rounded-full px-3 inline-flex items-center gap-1.5 text-[12px] font-semibold text-white/45 hover:text-white/80 hover:bg-white/[0.08] transition-all duration-200 cursor-pointer outline-none"
        >
          <MicVocal size={14} />
          <span>{t('track.lyrics')}</span>
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="w-9 h-9 rounded-full flex items-center justify-center text-white/25 hover:text-white/70 hover:bg-white/[0.08] transition-all duration-200 cursor-pointer outline-none"
        >
          <X size={18} />
        </button>
      </div>

      {/* Centered single column */}
      <div
        className="relative z-10 flex-1 flex items-center justify-center min-h-0"
        style={{ isolation: 'isolate' }}
      >
        <TrackColumn track={track} maxArt="max-w-[420px]" />
      </div>

      <FloatingComments mode="sidebar" />
    </div>
  );
});

/** Imperative API so NowPlayingBar can open without prop drilling */
export const artworkPanelApi = { open: () => {}, close: () => {} };
