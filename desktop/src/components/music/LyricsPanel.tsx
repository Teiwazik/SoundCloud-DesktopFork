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
  Heart,
  ListPlus,
  Loader2,
  MicVocal,
  pauseBlack18,
  playBlack18,
  repeat1Icon16,
  repeatIcon16,
  SkipBack,
  SkipForward,
  shuffleIcon16,
  X,
  Search,
  ExternalLink,
  volumeXIcon16,
  volume1Icon16,
  volume2Icon16,
} from '../../lib/icons';
import { optimisticToggleLike, useLiked } from '../../lib/likes';
import type { LyricLine, LyricsSource } from '../../lib/lyrics';
import { searchLyrics, splitArtistTitle } from '../../lib/lyrics';
import { useLyricsStore } from '../../stores/lyrics';
import { useDislikesStore } from '../../stores/dislikes';
import { useSoundWaveStore } from '../../stores/soundwave';
import { type Track, usePlayerStore } from '../../stores/player';
import { useSettingsStore } from '../../stores/settings';
import { ProgressSlider, ProgressTime } from '../layout/NowPlayingBar';
import { AddToPlaylistDialog } from './AddToPlaylistDialog';
import { FloatingComments } from './FloatingComments';
import { Visualizer } from './Visualizer';

/* ── Source Badge ─────────────────────────────────────────── */

const SOURCE_LABELS: Record<LyricsSource, string> = {
  lrclib: 'LRCLib',
  netease: 'NetEase',
  musixmatch: 'Musixmatch',
  genius: 'Genius',
  textyl: 'Textyl',
};

const LyricsSourceBadge = React.memo(({ source, onSearch }: { source: LyricsSource; onSearch?: () => void }) => (
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
));


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
    return (
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ contain: 'strict', transform: 'translateZ(0)' }}
      >
        {artworkSrc && (
          <img
            src={artworkSrc}
            alt=""
            className="w-full h-full object-cover scale-[1.4] blur-[100px] opacity-25 saturate-[1.5]"
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
        {useSettingsStore((s) => s.visualizerFullscreen) && <FullscreenVisualizer />}
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
  const liked = useLiked(track.urn);
  const qc = useQueryClient();

  const toggle = async () => {
    const next = !liked;
    optimisticToggleLike(qc, track, next);
    invalidateAllLikesCache();
    try {
      await api(`/likes/tracks/${encodeURIComponent(track.urn)}`, {
        method: next ? 'POST' : 'DELETE',
      });
    } catch {
      optimisticToggleLike(qc, track, !next);
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className={`w-11 h-11 rounded-full flex items-center justify-center transition-all duration-200 cursor-pointer hover:bg-white/[0.06] outline-none ${
        liked ? 'text-accent' : 'text-white/30 hover:text-white/60'
      }`}
    >
      <Heart size={20} fill={liked ? 'currentColor' : 'none'} />
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
              className={`absolute h-full rounded-full ${volume > 100 ? 'bg-amber-400/80' : 'bg-white/40'}`}
            />
          </Slider.Track>
          <Slider.Thumb
            className={`block w-2.5 h-2.5 rounded-full transition-all duration-150 outline-none scale-0 opacity-0 group-hover/vol:scale-100 group-hover/vol:opacity-100 ${volume > 100 ? 'bg-amber-400' : 'bg-white'}`}
          />
        </Slider.Root>
      </div>
      <span className="text-[10px] text-white/20 tabular-nums w-8 text-right font-medium">
        {volume}%
      </span>
    </div>
  );
});

/* ── Shared: transport controls + like ────────────────────── */

const Controls = React.memo(({ track }: { track: Track }) => {
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const next = usePlayerStore((s) => s.next);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const repeat = usePlayerStore((s) => s.repeat);
  const toggleRepeat = usePlayerStore((s) => s.toggleRepeat);

  const ctrl =
    'w-11 h-11 rounded-full flex items-center justify-center transition-all duration-150 cursor-pointer hover:bg-white/[0.06] outline-none';

  return (
    <div className="flex items-center justify-center gap-2">
      <AddToPlaylistDialog trackUrns={[track.urn]}>
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
        onClick={() => window.open(track.permalink_url, '_blank')}
        title="Open in SoundCloud"
      >
        <ExternalLink size={18} className="text-white/30 hover:text-white/60" />
      </button>
    </div>
  );
});

/* ── Shared: artwork + info + slider + controls column ────── */

const TrackColumn = React.memo(({ track, maxArt }: { track: Track; maxArt?: string }) => {
  const artwork500 = art(track.artwork_url, 't500x500');

  return (
    <div className="flex flex-col items-center justify-center gap-5 px-12">
      <div
        className={`w-full ${maxArt ?? 'max-w-[360px]'} aspect-square rounded-2xl overflow-hidden shadow-2xl shadow-black/60 ring-1 ring-white/[0.08]`}
      >
        {artwork500 ? (
          <img src={artwork500} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-white/[0.06] to-white/[0.02] flex items-center justify-center">
            <MicVocal size={48} className="text-white/10" />
          </div>
        )}
      </div>

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
  const linesRef = useRef(lines);
  const lineElsRef = useRef<HTMLElement[]>([]);
  linesRef.current = lines;

  // biome-ignore lint/correctness/useExhaustiveDependencies: lines triggers DOM re-cache
  useEffect(() => {
    const container = containerRef.current;
    if (container) {
      lineElsRef.current = Array.from(container.querySelectorAll<HTMLElement>('.lyric-line'));
    }
    activeRef.current = -1;

    const timerId = setInterval(() => {
      const lineEls = lineElsRef.current;
      if (!container || lineEls.length === 0) return;

      const time = getCurrentTime();
      const currentLines = linesRef.current;

      let idx = -1;
      for (let i = currentLines.length - 1; i >= 0; i--) {
        if (currentLines[i].time <= time + 0.3) {
          idx = i;
          break;
        }
      }
      if (idx === activeRef.current) return;

      const prev = activeRef.current;
      activeRef.current = idx;

      if (prev >= 0 && prev < lineEls.length) {
        lineEls[prev].dataset.state = prev < idx ? 'past' : '';
      }

      if (idx >= 0 && idx < lineEls.length) {
        lineEls[idx].dataset.state = 'active';
        const el = lineEls[idx];
        const top = el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2;
        container.scrollTo({ top, behavior: 'smooth' });
      }

      if (prev !== -1 && idx !== -1) {
        const lo = Math.min(prev, idx);
        const hi = Math.max(prev, idx);
        for (let i = lo; i <= hi; i++) {
          if (i === idx || i === prev) continue;
          const state = i < idx ? 'past' : '';
          if (lineEls[i].dataset.state !== state) lineEls[i].dataset.state = state;
        }
      }
    }, 200);

    return () => clearInterval(timerId);
  }, [lines]);

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto scrollbar-hide px-12 py-16 relative"
    >
      <div className="flex flex-col gap-2">
        {lines.map((line, i) => (
          <div 
             key={`${line.time}-${i}`} 
             className="lyric-line cursor-pointer origin-left transition-all duration-500 ease-[var(--ease-apple)] will-change-transform py-2.5 data-[state=active]:text-white data-[state=active]:scale-[1.03] data-[state=active]:opacity-100 data-[state=past]:text-white/20 data-[state=past]:scale-[0.97] text-[28px] font-bold tracking-tight text-white/40 scale-[0.97] pr-12 hover:text-white/60 antialiased" 
             style={{ textRendering: 'optimizeLegibility' }}
             onClick={() => seek(line.time)}
          >
            {line.text}
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
    queryFn: () => searchLyrics(reqArtist, reqTitle),
    enabled: open && !!track,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });

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

      {/* Close */}
      <div className="relative z-10 flex justify-end px-6 pt-5 pb-2" data-tauri-drag-region>
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
              <h3 className="text-white/80 font-bold mb-2">{t('track.manualSearch', 'Manual Search')}</h3>
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
                <button type="button" onClick={() => setIsEditing(false)} className="px-5 py-2 rounded-full text-[13px] font-medium text-white/50 hover:text-white hover:bg-white/10 transition-colors">
                  {t('eq.off', 'Cancel')}
                </button>
                <button type="button" onClick={() => { setManualQuery({ artist: editArtist, title: editTitle }); setIsEditing(false); }} className="px-6 py-2 rounded-full text-[13px] font-bold bg-white/20 hover:bg-white/30 text-white transition-colors">
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
              <LyricsSourceBadge source={lyrics.source} onSearch={() => {
                const parsed = splitArtistTitle(track?.title ?? '');
                setEditArtist(manualQuery?.artist || (parsed ? parsed[0] : track?.user.username || ''));
                setEditTitle(manualQuery?.title || (parsed ? parsed[1] : track?.title || ''));
                setIsEditing(true);
              }} />
              <SyncedLyrics lines={lyrics.synced} />
            </>
          ) : lyrics?.plain ? (
            <>
              <LyricsSourceBadge source={lyrics.source} onSearch={() => {
                const parsed = splitArtistTitle(track?.title ?? '');
                setEditArtist(manualQuery?.artist || (parsed ? parsed[0] : track?.user.username || ''));
                setEditTitle(manualQuery?.title || (parsed ? parsed[1] : track?.title || ''));
                setIsEditing(true);
              }} />
              <PlainLyrics text={lyrics.plain} />
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 px-12 text-center relative">
              <button
                type="button"
                onClick={() => {
                  const parsed = splitArtistTitle(track?.title ?? '');
                  setEditArtist(manualQuery?.artist || (parsed ? parsed[0] : track?.user.username || ''));
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
  const [open, setOpen] = useState(false);
  const track = usePlayerStore((s) => s.currentTrack);
  const colorRef = useArtworkColor(track?.artwork_url ?? null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  // Expose open/close
  useEffect(() => {
    artworkPanelApi.open = () => setOpen(true);
    artworkPanelApi.close = () => setOpen(false);
  }, []);

  if (!open || !track) return null;

  const artwork500 = art(track.artwork_url, 't500x500');

  return (
    <div className="fixed inset-0 z-[60] flex flex-col overflow-hidden animate-fade-in-up bg-[#08080a]">
      <FullscreenBackground artworkSrc={artwork500} color={colorRef.current} />

      {/* Close */}
      <div className="relative z-10 flex justify-end px-6 pt-5 pb-2" data-tauri-drag-region>
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
