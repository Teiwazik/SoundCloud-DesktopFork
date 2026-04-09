import * as Slider from '@radix-ui/react-slider';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { isAppBackgrounded } from '../../lib/app-visibility';
import {
  getFallbackArtworkGradientPalette,
  useArtworkGradientPalette,
} from '../../lib/artwork-palette';
import { getCurrentTime, getSmoothCurrentTime, handlePrev, seek } from '../../lib/audio';
import type { AudioFeatures } from '../../lib/audio-analyser';
import { audioAnalyser } from '../../lib/audio-analyser';
import { art } from '../../lib/formatters';
import { getAnimationFrameBudgetMs } from '../../lib/framerate';
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
import type { LyricLine, LyricsSource, TimedCommentLike } from '../../lib/lyrics';
import {
  getLyricMotionHintsForTrack,
  LYRICS_SEARCH_QUERY_VERSION,
  resolveLyricsAutoSyncFromCommentsOrAsr,
  searchLyrics,
  splitArtistTitle,
} from '../../lib/lyrics';
import { useDislikesStore } from '../../stores/dislikes';
import { useArtworkStore, useFullscreenPanelStore, useLyricsStore } from '../../stores/lyrics';
import {
  getEffectivePitchSemitones,
  isTrackPlaybackRateEnabledForTrack,
  PITCH_SEMITONES_MAX,
  PITCH_SEMITONES_MIN,
  PITCH_SEMITONES_STEP,
  PLAYBACK_RATE_MAX,
  PLAYBACK_RATE_MIN,
  PLAYBACK_RATE_STEP,
  type Track,
  usePlayerStore,
} from '../../stores/player';
import { useSettingsStore } from '../../stores/settings';
import { useSoundWaveStore } from '../../stores/soundwave';
import { ProgressSlider, ProgressTime } from '../layout/NowPlayingBar';
import { AddToPlaylistDialog } from './AddToPlaylistDialog';
import { FloatingComments } from './FloatingComments';
import { StreamQualityBadge } from './StreamQualityBadge';
import { Visualizer } from './Visualizer';

/* ── Source Badge ─────────────────────────────────────────── */

const SOURCE_LABELS: Record<LyricsSource, string> = {
  soundcloud: 'SoundCloud',
  lrclib: 'LRCLib',
  netease: 'NetEase',
  musixmatch: 'Musixmatch',
  genius: 'Genius',
  textyl: 'Textyl',
  kroko: 'Genius',
  qwen: 'Genius',
  vosk: 'Genius',
};

interface TimedComment {
  id: number;
  body: string;
  timestamp: number | null;
  user: {
    username: string;
    avatar_url: string;
  };
}

function useTimedComments(trackUrn: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['comments', trackUrn],
    queryFn: async () => {
      const res = await api<{ collection: TimedComment[] }>(
        `/tracks/${encodeURIComponent(trackUrn!)}/comments?limit=200`,
      );
      return res.collection || [];
    },
    enabled: enabled && !!trackUrn,
    staleTime: 60 * 60 * 1000,
  });
}

function toTimedCommentLikes(comments: TimedComment[] | undefined): TimedCommentLike[] {
  return (comments || []).map((comment) => ({
    id: comment.id,
    body: comment.body,
    timestamp: comment.timestamp,
  }));
}

function PseudoSyncHint() {
  return (
    <div className="px-12 pt-2 pb-0">
      <div className="inline-flex items-center rounded-full border border-white/[0.06] bg-white/[0.04] px-2.5 py-1 text-[10px] font-semibold text-white/28">
        Approx sync from timed comments
      </div>
    </div>
  );
}

function useResolvedLyrics(
  visible: boolean,
  track: Track | null | undefined,
  reqArtist: string,
  reqTitle: string,
  trackDurationMs: number | undefined,
  allowApproxSync: boolean,
) {
  const trackUrn = track?.urn;
  const lyricsQuery = useQuery({
    queryKey: ['lyrics', LYRICS_SEARCH_QUERY_VERSION, trackUrn, reqArtist, reqTitle],
    queryFn: () =>
      searchLyrics(
        trackUrn!,
        reqArtist,
        reqTitle,
        getLyricsSearchOptions(track, reqArtist, reqTitle, trackDurationMs),
      ),
    enabled: visible && !!trackUrn,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });

  const shouldLoadComments =
    allowApproxSync &&
    visible &&
    !!trackUrn &&
    Boolean(lyricsQuery.data?.plain && !lyricsQuery.data?.synced);
  const commentsQuery = useTimedComments(trackUrn, shouldLoadComments);
  const timedComments = useMemo(
    () => toTimedCommentLikes(commentsQuery.data),
    [commentsQuery.data],
  );

  const resolvedQuery = useQuery({
    queryKey: [
      'lyrics-resolved',
      4,
      trackUrn,
      reqArtist,
      reqTitle,
      lyricsQuery.data?.source ?? null,
      lyricsQuery.data?.plain ?? null,
      lyricsQuery.data?.synced?.length ?? 0,
      allowApproxSync,
      timedComments.length,
      trackDurationMs,
    ],
    queryFn: () =>
      resolveLyricsAutoSyncFromCommentsOrAsr(
        trackUrn ?? '',
        lyricsQuery.data ?? null,
        timedComments,
        reqArtist,
        reqTitle,
        allowApproxSync,
        trackDurationMs,
      ),
    enabled:
      allowApproxSync &&
      visible &&
      Boolean(lyricsQuery.data?.plain && !lyricsQuery.data?.synced) &&
      !commentsQuery.isLoading,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });

  const data = resolvedQuery.data ?? lyricsQuery.data ?? null;

  const generatedFromPlain = Boolean(
    lyricsQuery.data?.plain && !lyricsQuery.data?.synced && data?.synced,
  );

  const pseudoSynced = Boolean(
    generatedFromPlain &&
      allowApproxSync &&
      lyricsQuery.data &&
      data?.source === lyricsQuery.data.source &&
      timedComments.length >= 2 &&
      (lyricsQuery.data.source === 'genius' || lyricsQuery.data.source === 'musixmatch'),
  );

  return {
    data,
    loadingPlain: lyricsQuery.data?.plain ?? null,
    loadingSource: lyricsQuery.data?.source ?? null,
    isLoading:
      lyricsQuery.isLoading ||
      (shouldLoadComments && commentsQuery.isLoading) ||
      resolvedQuery.isLoading,
    pseudoSynced,
    generatedFromPlain,
  };
}

function getTrackDurationMs(track: Track | null | undefined): number | undefined {
  return track?.duration;
}

function getLyricsSearchOptions(
  track: Track | null | undefined,
  reqArtist: string,
  reqTitle: string,
  trackDurationMs?: number,
) {
  const originalArtist = track?.user?.username ?? '';
  const originalTitle = track?.title ?? '';
  return {
    uploaderUsername: originalArtist,
    originalTitle,
    durationMs: trackDurationMs,
    genre: track?.genre ?? null,
    tagList: track?.tag_list ?? null,
    description: track?.description ?? null,
    createdAt: track?.created_at ?? null,
    artworkUrl: track?.artwork_url ?? null,
    forceRefresh: reqArtist !== originalArtist || reqTitle !== originalTitle,
  };
}

function shouldRenderSyncedLyrics(
  lyrics: LyricLine[] extends never
    ? never
    : { synced: LyricLine[] | null; source: LyricsSource; plain: string | null } | null | undefined,
): lyrics is { synced: LyricLine[]; source: LyricsSource; plain: string | null } {
  return Boolean(lyrics?.synced?.length);
}

function shouldRenderPlainLyrics(
  lyrics:
    | { plain: string | null; source: LyricsSource; synced: LyricLine[] | null }
    | null
    | undefined,
): lyrics is { plain: string; source: LyricsSource; synced: null } {
  return Boolean(lyrics?.plain && !lyrics?.synced);
}

function shouldShowPseudoSyncHint(
  lyrics:
    | { plain: string | null; source: LyricsSource; synced: LyricLine[] | null }
    | null
    | undefined,
  pseudoSynced: boolean,
): boolean {
  return Boolean(
    pseudoSynced && lyrics && (lyrics.source === 'genius' || lyrics.source === 'musixmatch'),
  );
}

const resolveTrackPermalink = async (track: Track): Promise<string | null> => {
  const direct = track.permalink_url?.trim();
  if (direct) return direct;

  try {
    const refreshed = await api<Pick<Track, 'permalink_url'>>(
      `/tracks/${encodeURIComponent(track.urn)}`,
      {
        quietHttpErrors: true,
      },
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

/* ── Shared: dynamic background ───────────────────────────── */

const FullscreenBackground = React.memo(
  ({ artworkSrc, color }: { artworkSrc: string | null; color: [number, number, number] }) => {
    const [r, g, b] = color;
    return (
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ contain: 'strict', transform: 'translateZ(0)' }}
      >
        {artworkSrc ? (
          <>
            <img
              src={artworkSrc}
              alt=""
              className="w-full h-full object-cover scale-[1.2] blur-[72px] opacity-24 saturate-[1.18]"
              loading="eager"
              decoding="async"
              fetchPriority="low"
            />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(8,8,10,0.06)_0%,rgba(8,8,10,0.5)_62%,rgba(8,8,10,0.82)_100%)]" />
          </>
        ) : (
          <div
            className="absolute inset-0"
            style={{
              background: `
                radial-gradient(ellipse at 25% 50%, rgba(${r},${g},${b},0.2) 0%, transparent 60%),
                radial-gradient(ellipse at 75% 70%, rgba(${r},${g},${b},0.12) 0%, transparent 50%)
              `,
            }}
          />
        )}
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,8,10,0.3)_0%,rgba(8,8,10,0.56)_48%,rgba(8,8,10,0.84)_100%)]" />
      </div>
    );
  },
);

/* ── Fullscreen Visualizer ────────────────────────────────── */

const FullscreenVisualizer = React.memo(() => {
  const w = useSettingsStore((s) => s.visualizerWidth);
  const op = useSettingsStore((s) => s.visualizerOpacity);
  const fade = useSettingsStore((s) => s.visualizerFade);
  const fadeStart = Math.max(30, 64 - fade * 0.22);
  const fadeMid = Math.max(fadeStart + 16, 82 - fade * 0.18);
  const mask = `linear-gradient(to top, black 0%, black ${fadeStart}%, rgba(0,0,0,0.84) ${fadeMid}%, transparent 100%)`;
  const glowOpacity = Math.min(0.88, op / 100);

  return (
    <div
      className="absolute inset-x-0 bottom-0 z-0 pointer-events-none overflow-visible"
      style={{
        height: '46%',
        minHeight: '280px',
        maxHeight: '480px',
      }}
    >
      <div
        className="absolute bottom-0 left-1/2 h-full -translate-x-1/2 overflow-visible mix-blend-screen"
        style={{
          width: `${w}%`,
          opacity: glowOpacity,
          maskImage: mask,
          WebkitMaskImage: mask,
          filter:
            'drop-shadow(0 0 18px var(--color-accent-glow)) drop-shadow(0 0 44px rgba(255,255,255,0.1))',
        }}
      >
        <Visualizer className="h-full w-full" />
      </div>
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
    (trackData ? Boolean(trackData.user_favorite) : likedFromStore || Boolean(track.user_favorite));

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
    <div
      className="flex items-center gap-3 w-full max-w-[280px] mt-2 group/vol"
      onWheel={(event) => {
        if (event.cancelable) {
          event.preventDefault();
        }
        setVolume(Math.max(0, Math.min(200, volume + (event.deltaY < 0 ? 2 : -2))));
      }}
    >
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
      <span
        className={`text-[10px] tabular-nums w-8 text-right font-medium ${volume > 100 ? 'text-accent/90' : 'text-white/20'}`}
      >
        {volume}%
      </span>
    </div>
  );
});

const FullscreenPlaybackSpeedSlider = React.memo(() => {
  const { t } = useTranslation();
  const playbackRate = usePlayerStore((s) => s.playbackRate);
  const setPlaybackRate = usePlayerStore((s) => s.setPlaybackRate);
  const resetPlaybackRate = usePlayerStore((s) => s.resetPlaybackRate);
  const isDefaultRate = Math.abs(playbackRate - 1) < 0.001;

  return (
    <div className="grid grid-cols-[2rem_minmax(0,1fr)_2rem] items-center gap-3 w-full max-w-[280px] group/rate">
      <button
        type="button"
        title={isDefaultRate ? t('player.playbackSpeed') : t('player.playbackSpeedReset')}
        onClick={() => {
          if (!isDefaultRate) resetPlaybackRate();
        }}
        className={`w-8 justify-self-center text-center text-[9px] font-semibold tabular-nums transition-colors ${
          isDefaultRate ? 'text-white/30 hover:text-white/60' : 'text-accent hover:text-accent/80'
        }`}
      >
        {formatPlaybackRate(playbackRate)}
      </button>
      <div className="flex-1 relative flex items-center h-5">
        <Slider.Root
          className="relative flex items-center h-full w-full cursor-pointer select-none touch-none"
          aria-label={t('player.playbackSpeed')}
          value={[playbackRate]}
          min={PLAYBACK_RATE_MIN}
          max={PLAYBACK_RATE_MAX}
          step={PLAYBACK_RATE_STEP}
          onValueChange={([value]) => setPlaybackRate(value)}
          onWheel={(event) => {
            if (event.cancelable) {
              event.preventDefault();
            }
            setPlaybackRate(
              playbackRate + (event.deltaY < 0 ? PLAYBACK_RATE_STEP : -PLAYBACK_RATE_STEP),
            );
          }}
        >
          <Slider.Track className="relative h-[3px] grow rounded-full bg-white/[0.08] group-hover/rate:h-[4px] transition-all duration-150">
            <Slider.Range className="absolute h-full rounded-full theme-accent-progress theme-accent-animated" />
          </Slider.Track>
          <Slider.Thumb className="block w-2.5 h-2.5 rounded-full theme-accent-thumb theme-accent-animated transition-all duration-150 outline-none scale-0 opacity-0 group-hover/rate:scale-100 group-hover/rate:opacity-100" />
        </Slider.Root>
      </div>
      <span aria-hidden="true" className="block w-8" />
    </div>
  );
});

const FullscreenTrackPlaybackRateButton = React.memo(() => {
  const { t } = useTranslation();
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const trackPlaybackRateEnabledByUrn = usePlayerStore((s) => s.trackPlaybackRateEnabledByUrn);
  const setCurrentTrackPlaybackRateEnabled = usePlayerStore(
    (s) => s.setCurrentTrackPlaybackRateEnabled,
  );
  const isEnabled = isTrackPlaybackRateEnabledForTrack(currentTrack, trackPlaybackRateEnabledByUrn);

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isEnabled}
      disabled={!currentTrack}
      title={
        isEnabled ? t('player.playbackSpeedTrackDisable') : t('player.playbackSpeedTrackEnable')
      }
      onClick={() => setCurrentTrackPlaybackRateEnabled(!isEnabled)}
      className={`h-5 rounded-full px-2.5 text-[9px] font-semibold uppercase tracking-[0.08em] transition-colors ${
        !currentTrack
          ? 'cursor-not-allowed text-white/22'
          : isEnabled
            ? 'bg-white text-black'
            : 'text-white/38 hover:text-white/70'
      }`}
    >
      {t('player.playbackSpeedTrackToggle')}
    </button>
  );
});

const FullscreenPitchSlider = React.memo(() => {
  const { t } = useTranslation();
  const playbackRate = usePlayerStore((s) => s.playbackRate);
  const pitchSemitones = usePlayerStore((s) => s.pitchSemitones);
  const pitchControlMode = usePlayerStore((s) => s.pitchControlMode);
  const setPitchSemitones = usePlayerStore((s) => s.setPitchSemitones);
  const resetPitchSemitones = usePlayerStore((s) => s.resetPitchSemitones);
  const effectivePitchSemitones = getEffectivePitchSemitones(
    playbackRate,
    pitchControlMode,
    pitchSemitones,
  );
  const isManualMode = pitchControlMode === 'manual';
  const canResetPitch = isManualMode && Math.abs(pitchSemitones) >= 0.001;

  return (
    <div className="grid grid-cols-[2rem_minmax(0,1fr)_2rem] items-center gap-3 w-full max-w-[280px] group/pitch">
      <button
        type="button"
        title={
          isManualMode
            ? canResetPitch
              ? t('player.pitchReset')
              : t('player.pitch')
            : t('player.pitchModeAuto')
        }
        onClick={() => {
          if (canResetPitch) resetPitchSemitones();
        }}
        className={`w-8 justify-self-center text-center text-[9px] font-semibold tabular-nums transition-colors ${
          canResetPitch ? 'text-accent hover:text-accent/80' : 'text-white/30 hover:text-white/60'
        }`}
      >
        {formatPitchSemitonesCompact(effectivePitchSemitones)}
      </button>
      <div className={`flex-1 relative flex items-center h-5 ${isManualMode ? '' : 'opacity-45'}`}>
        <Slider.Root
          className="relative flex items-center h-full w-full cursor-pointer select-none touch-none"
          aria-label={t('player.pitch')}
          value={[effectivePitchSemitones]}
          min={PITCH_SEMITONES_MIN}
          max={PITCH_SEMITONES_MAX}
          step={PITCH_SEMITONES_STEP}
          disabled={!isManualMode}
          onValueChange={([value]) => {
            if (isManualMode) {
              setPitchSemitones(value);
            }
          }}
          onWheel={(event) => {
            if (!isManualMode) return;
            if (event.cancelable) {
              event.preventDefault();
            }
            setPitchSemitones(
              pitchSemitones + (event.deltaY < 0 ? PITCH_SEMITONES_STEP : -PITCH_SEMITONES_STEP),
            );
          }}
        >
          <Slider.Track className="relative h-[3px] grow rounded-full bg-white/[0.08] group-hover/pitch:h-[4px] transition-all duration-150">
            <Slider.Range className="absolute h-full rounded-full theme-accent-progress theme-accent-animated" />
          </Slider.Track>
          <Slider.Thumb className="block w-2.5 h-2.5 rounded-full theme-accent-thumb theme-accent-animated transition-all duration-150 outline-none scale-0 opacity-0 group-hover/pitch:scale-100 group-hover/pitch:opacity-100" />
        </Slider.Root>
      </div>
      <span aria-hidden="true" className="block w-8" />
    </div>
  );
});

const FullscreenPitchModeToggle = React.memo(() => {
  const { t } = useTranslation();
  const pitchControlMode = usePlayerStore((s) => s.pitchControlMode);
  const setPitchControlMode = usePlayerStore((s) => s.setPitchControlMode);

  return (
    <div className="flex justify-center w-full max-w-[280px]">
      <div className="flex items-center rounded-full border border-white/[0.08] bg-white/[0.04] p-[2px]">
        <button
          type="button"
          title={t('player.pitchModeAuto')}
          onClick={() => setPitchControlMode('auto')}
          className={`h-5 min-w-[40px] rounded-full px-2 text-[9px] font-semibold uppercase tracking-[0.08em] transition-colors ${
            pitchControlMode === 'auto'
              ? 'bg-white text-black'
              : 'text-white/38 hover:text-white/70'
          }`}
        >
          {t('player.pitchModeAutoShort')}
        </button>
        <button
          type="button"
          title={t('player.pitchModeManual')}
          onClick={() => setPitchControlMode('manual')}
          className={`h-5 min-w-[40px] rounded-full px-2 text-[9px] font-semibold uppercase tracking-[0.08em] transition-colors ${
            pitchControlMode === 'manual'
              ? 'bg-white text-black'
              : 'text-white/38 hover:text-white/70'
          }`}
        >
          {t('player.pitchModeManualShort')}
        </button>
        <div aria-hidden="true" className="mx-1 h-3.5 w-px bg-white/[0.08]" />
        <FullscreenTrackPlaybackRateButton />
      </div>
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
  const fullscreenArtSources = useMemo(
    () =>
      [artwork500, artworkOriginal, artwork200].filter(
        (value, index, items): value is string => Boolean(value) && items.indexOf(value) === index,
      ),
    [artwork200, artwork500, artworkOriginal],
  );
  const [loaded, setLoaded] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [showFullArt, setShowFullArt] = useState(false);
  const [fullscreenArtIndex, setFullscreenArtIndex] = useState(0);
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
      setFullscreenArtIndex(0);

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

  useEffect(() => {
    if (!showFullArt) {
      setFullscreenArtIndex(0);
    }
  }, [showFullArt, track.urn]);

  useEffect(() => {
    const urls = [artwork500, artworkOriginal].filter(
      (value, index, items): value is string => Boolean(value) && items.indexOf(value) === index,
    );
    const preloadedImages: HTMLImageElement[] = [];

    for (const [index, url] of urls.entries()) {
      const img = new window.Image();
      img.decoding = 'async';
      img.loading = 'eager';
      img.fetchPriority = index === 0 ? 'high' : 'auto';
      img.src = url;
      preloadedImages.push(img);
    }

    return () => {
      for (const img of preloadedImages) {
        img.src = '';
      }
    };
  }, [artwork500, artworkOriginal, track.urn]);

  const fullscreenArtSrc = fullscreenArtSources[fullscreenArtIndex] ?? null;
  const fullArtModal =
    showFullArt && fullscreenArtSrc && typeof document !== 'undefined'
      ? createPortal(
          <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/90 p-8 backdrop-blur-xl sm:p-12">
            <div
              className="absolute inset-0 cursor-pointer"
              onClick={() => setShowFullArt(false)}
            />
            <button
              type="button"
              onClick={() => setShowFullArt(false)}
              className="absolute right-6 top-6 z-10 flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-white/10 text-white transition-all hover:bg-white/20"
            >
              <X size={20} />
            </button>
            <div
              className="relative z-10 aspect-square w-[min(calc(100vw-4rem),calc(100vh-4rem))] max-w-full max-h-full sm:w-[min(calc(100vw-6rem),calc(100vh-6rem))]"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="h-full w-full overflow-hidden rounded-[28px] border border-white/10 bg-black/24 shadow-[0_32px_128px_rgba(0,0,0,0.8)]">
                <img
                  src={fullscreenArtSrc}
                  alt={track.title}
                  loading="eager"
                  decoding="async"
                  fetchPriority="high"
                  className="h-full w-full animate-zoom-in rounded-[28px] object-cover"
                  onError={() => {
                    setFullscreenArtIndex((current) =>
                      current + 1 < fullscreenArtSources.length ? current + 1 : current,
                    );
                  }}
                />
              </div>
            </div>
            <div className="pointer-events-none absolute bottom-8 left-1/2 z-10 w-[min(560px,calc(100vw-3rem))] -translate-x-1/2 px-3">
              <div className="mx-auto flex w-fit max-w-full flex-col items-center gap-0.5 rounded-2xl border border-white/10 bg-black/42 px-4 py-3 text-center shadow-[0_18px_60px_rgba(0,0,0,0.42)] backdrop-blur-xl">
                <p className="max-w-[min(480px,calc(100vw-6rem))] truncate text-lg font-bold text-white/92">
                  {track.title}
                </p>
                <p className="max-w-[min(440px,calc(100vw-6rem))] truncate text-sm text-white/48">
                  {track.user.username}
                </p>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <div className="relative z-10 flex h-full min-h-0 w-full flex-col items-center justify-center gap-5 px-12">
      <div
        className={`w-full ${maxArt ?? 'max-w-[360px]'} aspect-square rounded-2xl overflow-hidden shadow-2xl shadow-black/60 ring-1 ring-white/[0.08] relative group/art`}
      >
        {artwork500 ? (
          <>
            {/* Low-res placeholder (Blur applied only during track switch) */}
            <img
              src={artwork200 || artwork500}
              alt=""
              loading="eager"
              decoding="async"
              fetchPriority="high"
              className={`absolute inset-0 w-full h-full object-cover scale-110 transition-all duration-700 ease-[var(--ease-apple)] ${
                isSwitching ? 'blur-2xl scale-125' : ''
              } ${loaded ? 'opacity-0' : 'opacity-100'}`}
            />
            {/* High-res image */}
            <img
              src={artwork500}
              alt=""
              loading="eager"
              decoding="async"
              fetchPriority="high"
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
                <span className="text-[11px] font-bold tracking-wider uppercase opacity-60">
                  Просмотр
                </span>
              </div>
            </button>
          </>
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-white/[0.06] to-white/[0.02] flex items-center justify-center">
            <MicVocal size={48} className="text-white/10" />
          </div>
        )}
      </div>

      {fullArtModal}

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

      <div className="relative z-20">
        <Controls track={track} />
      </div>

      <div
        className={`relative z-20 flex w-full ${maxArt ?? 'max-w-[360px]'} flex-col items-center gap-1 rounded-[22px] border border-white/[0.08] bg-black/28 px-4 py-3 shadow-[0_20px_70px_rgba(0,0,0,0.32)] backdrop-blur-xl`}
      >
        <FullscreenVolumeSlider />
        <FullscreenPlaybackSpeedSlider />
        <FullscreenPitchSlider />
        <FullscreenPitchModeToggle />
      </div>
    </div>
  );
});

/* ── Shared: color hook ───────────────────────────────────── */

function useArtworkColor(artworkUrl: string | null) {
  return (
    useArtworkGradientPalette(artworkUrl)?.accent ?? getFallbackArtworkGradientPalette().accent
  );
}

function clamp01(value: number) {
  return Math.max(0, Math.min(value, 1));
}

function formatPlaybackRate(rate: number): string {
  return `${rate
    .toFixed(2)
    .replace(/\.00$/, '')
    .replace(/(\.\d)0$/, '$1')}x`;
}

function formatPitchSemitonesCompact(semitones: number): string {
  if (Math.abs(semitones) < 0.001) return '0';
  return `${semitones > 0 ? '+' : ''}${semitones.toFixed(1).replace(/\.0$/, '')}`;
}

function getSmoothLyricTime(): number {
  try {
    return getSmoothCurrentTime();
  } catch {
    return getCurrentTime();
  }
}

const LYRIC_ACTIVE_TIME_BIAS_PER_RATE = 0.11;
const LYRIC_ACTIVE_TIME_MIN_OFFSET_SEC = -0.03;
const LYRIC_ACTIVE_TIME_MAX_OFFSET_SEC = 0.08;

function getActiveLyricTime(rawTime: number): number {
  const smoothTime = getSmoothLyricTime();
  const playbackRate = Math.max(
    PLAYBACK_RATE_MIN,
    Math.min(PLAYBACK_RATE_MAX, usePlayerStore.getState().playbackRate),
  );
  const smoothLead = smoothTime - rawTime;
  const rateBias = (1 - playbackRate) * LYRIC_ACTIVE_TIME_BIAS_PER_RATE;
  const correctedLead = Math.max(
    LYRIC_ACTIVE_TIME_MIN_OFFSET_SEC,
    Math.min(LYRIC_ACTIVE_TIME_MAX_OFFSET_SEC, smoothLead + rateBias),
  );
  return Math.max(0, rawTime + correctedLead);
}

function stabilizeCharProgress(value: number) {
  const clamped = clamp01(value);
  if (clamped >= 0.996) return 1;
  if (clamped <= 0.001) return 0;
  return clamped;
}

function isAnimatedLyricChar(char: string) {
  return !/^\s$/u.test(char);
}

function countAnimatedLyricChars(text: string) {
  return Array.from(text).filter(isAnimatedLyricChar).length;
}

function getLyricCharOnsetFactor(headPosition: number) {
  return clamp01(headPosition / 1.4);
}

const LYRIC_TRAIL_CHAR_SPAN = 4.4;
const LYRIC_CURSOR_CHAR_SPAN = 1.7;

function getLyricAnimatedCharCount(lineEl: HTMLElement) {
  const raw = Number(lineEl.dataset.charCount ?? '0');
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

function getLyricTransitionWindow(progress: number, charCount: number) {
  const safeProgress = clamp01(progress);
  const safeCharCount = Math.max(1, charCount);
  const tailSpan = Math.max(3.2, Math.min(LYRIC_TRAIL_CHAR_SPAN, safeCharCount * 0.2));
  const cursorSpan = Math.max(1.05, Math.min(LYRIC_CURSOR_CHAR_SPAN, tailSpan * 0.46));
  const charUnit = 1 / safeCharCount;

  return {
    tailStart: safeProgress,
    tailEnd: clamp01(safeProgress + tailSpan * charUnit),
    cursorStart: clamp01(safeProgress - cursorSpan * charUnit * 0.34),
    cursorEnd: clamp01(safeProgress + cursorSpan * charUnit * 0.92),
  };
}

function applyLyricProgressStyle(lineEl: HTMLElement, progress: number) {
  const safeProgress = clamp01(progress);
  const { tailStart, tailEnd, cursorStart, cursorEnd } = getLyricTransitionWindow(
    safeProgress,
    getLyricAnimatedCharCount(lineEl),
  );

  lineEl.style.setProperty('--lyric-progress', `${safeProgress * 100}%`);
  lineEl.style.setProperty('--lyric-progress-value', `${safeProgress}`);
  lineEl.style.setProperty('--lyric-tail-start', `${tailStart}`);
  lineEl.style.setProperty('--lyric-tail-end', `${tailEnd}`);
  lineEl.style.setProperty('--lyric-cursor-start', `${cursorStart}`);
  lineEl.style.setProperty('--lyric-cursor-end', `${cursorEnd}`);
  lineEl.style.setProperty(
    '--lyric-cursor-opacity',
    safeProgress > 0.001 && safeProgress < 0.999 ? '1' : '0',
  );
}

function syncLyricCharProgress(charEl: HTMLElement, progress: number) {
  const clamped = stabilizeCharProgress(progress);
  const easedProgress = clamped * clamped * (3 - 2 * clamped);
  const charState = easedProgress >= 0.996 ? 'active' : easedProgress > 0 ? 'fading' : '';

  charEl.style.setProperty('--char-progress', `${easedProgress}`);
  charEl.dataset.charState = charState;
}

function getLyricMotionWeight(text: string | undefined) {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized === '♪♪♪' || normalized === '...') return 0.6;
  return Math.max(0.72, Math.min(normalized.length / 16, 1.65));
}

function countLyricVowels(value: string) {
  return (value.match(/[aeiouyаеёиоуыэюя]/giu) || []).length;
}

function getRapLineBoost(text: string | undefined) {
  const normalized = (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || normalized === '♪♪♪' || normalized === '...') return 0;

  const tokens = normalized.split(' ').filter(Boolean);
  const vowels = countLyricVowels(normalized);
  const cyr = (normalized.match(/[а-яё]/giu) || []).length;
  const lat = (normalized.match(/[a-z]/giu) || []).length;
  const denseLanguage = cyr > 0 || lat > 0;
  const languageBoost = cyr > 0 && lat > 0 ? 0.2 : denseLanguage ? 0.12 : 0;
  const rapidMarkers =
    /\b(yeah|hey|go|get|run|drop|drip|flow|fast|дай|бей|эй|го|лети|пау|пау|рау|скрт)\b/iu.test(
      normalized,
    )
      ? 0.12
      : 0;
  const repeatedEdges =
    (normalized.match(/[бвгджзйклмнпрстфхцчшщbcdfghjklmnpqrstvwxyz]/giu) || []).length /
    Math.max(normalized.length, 1);
  const density =
    tokens.length * 0.11 + vowels * 0.03 + repeatedEdges * 0.9 + languageBoost + rapidMarkers;

  return clamp01((density - 0.72) / 0.9);
}

function getReactiveLyricDrive(features: AudioFeatures | null, rapBoost = 0) {
  if (!features) {
    return {
      speedMultiplier: 1 + rapBoost * 0.12,
      onsetPull: rapBoost * 0.12,
    };
  }

  const flux = clamp01((features.flux - 0.02) / 0.11);
  const mids = clamp01(features.midPresence ?? 0);
  const bass = clamp01(features.subBass ?? 0);
  const dynamics = clamp01(features.dynamicRange ?? 0);
  const stability = clamp01(features.rhythmicStability ?? 0.5);
  const arousal = clamp01(features.arousal);
  const bpmDrive = clamp01(((features.bpm || 0) - 84) / 72);
  const rapPresence = clamp01(
    mids * 0.34 + flux * 0.28 + bpmDrive * 0.18 + dynamics * 0.12 + rapBoost * 0.48,
  );

  const dropDrive = clamp01(
    bass * 0.24 +
      dynamics * 0.22 +
      arousal * 0.17 +
      flux * 0.14 +
      bpmDrive * 0.08 +
      stability * 0.07 +
      rapBoost * 0.22,
  );
  const onsetPull = clamp01(
    flux * 0.46 +
      mids * 0.18 +
      dynamics * 0.12 +
      stability * 0.08 +
      rapPresence * 0.26 +
      rapBoost * 0.14,
  );

  return {
    speedMultiplier: 1 + dropDrive * 0.34 + onsetPull * 0.18 + rapPresence * 0.32 + rapBoost * 0.22,
    onsetPull,
  };
}

function getAnimatedLineProgress(
  lines: (LyricLine | { time: number; text: string; isPlaceholder: true })[],
  idx: number,
  time: number,
  reactiveMode: boolean,
  features: AudioFeatures | null,
  hintBoost = 0,
) {
  const currentLine = lines[idx];
  if (!currentLine) return 0;

  const nextLine = lines[idx + 1];
  const prevLine = lines[idx - 1];
  const rawDuration = Math.max((nextLine?.time ?? currentLine.time + 2.4) - currentLine.time, 0.35);
  const rawProgress = clamp01((time - currentLine.time) / rawDuration);
  if (!reactiveMode) return rawProgress;

  const prevDuration = prevLine ? Math.max(currentLine.time - prevLine.time, 0.35) : rawDuration;
  const prevWeight = getLyricMotionWeight(prevLine?.text);
  const currentWeight = getLyricMotionWeight(currentLine.text);
  const rapBoost = getRapLineBoost(currentLine.text);
  const continuityDuration = Math.max(
    0.32,
    Math.min(
      rawDuration,
      prevDuration *
        clamp01(currentWeight / Math.max(prevWeight, 0.001)) *
        (1.25 - rapBoost * 0.18),
    ),
  );
  const { speedMultiplier, onsetPull } = getReactiveLyricDrive(features, rapBoost);
  const boostedDuration = Math.max(
    0.2,
    continuityDuration / (speedMultiplier + hintBoost * 0.22 + rapBoost * 0.3),
  );
  const boostedProgress = clamp01((time - currentLine.time) / boostedDuration);
  const blendedProgress = Math.max(rawProgress, boostedProgress);

  return clamp01(
    blendedProgress +
      (1 - blendedProgress) * onsetPull * (0.18 + hintBoost * 0.06 + rapBoost * 0.08),
  );
}

function getMotionHintBoost(
  motionHints: Array<{ index: number; importance: number; density: number; onsetBias: number }>,
  idx: number,
) {
  let best = 0;
  for (const hint of motionHints) {
    const distance = Math.abs(hint.index - idx);
    if (distance > 2) continue;
    const proximity = distance === 0 ? 1 : distance === 1 ? 0.58 : 0.24;
    const score = (hint.importance * 0.5 + hint.density * 0.28 + hint.onsetBias * 0.22) * proximity;
    if (score > best) best = score;
  }
  return clamp01(best / 1.45);
}

function getMotionHintFloor(
  motionHints: Array<{ importance: number; onsetBias: number; density?: number }>,
) {
  if (!motionHints.length) return 1;
  const peak = Math.max(
    ...motionHints.map(
      (hint) => hint.importance * 0.56 + hint.onsetBias * 0.24 + (hint.density ?? 0) * 0.2,
    ),
  );
  return 1 + clamp01(peak / 1.95) * 0.13;
}

function getAudioTextHintLabel(motionHints: Array<{ language: string }>) {
  const hasRu = motionHints.some((hint) => hint.language === 'ru' || hint.language === 'mixed');
  const hasEn = motionHints.some((hint) => hint.language === 'en' || hint.language === 'mixed');
  if (hasRu && hasEn) return 'RU/EN';
  if (hasRu) return 'RU';
  if (hasEn) return 'EN';
  return null;
}

function AudioTextWarmupHint({ label }: { label: string | null }) {
  if (!label) return null;
  return (
    <div className="px-12 pt-2 pb-0">
      <div className="inline-flex items-center rounded-full border border-white/[0.06] bg-white/[0.04] px-2.5 py-1 text-[10px] font-semibold text-white/28">
        Light audio-text warmup {label}
      </div>
    </div>
  );
}

function useWarmLyricMotionHints(
  trackUrn: string | undefined,
  lyrics: { synced?: LyricLine[] | null } | null | undefined,
  enabled: boolean,
) {
  const [motionHints, setMotionHints] = useState<ReturnType<typeof getLyricMotionHintsForTrack>>(
    [],
  );

  useEffect(() => {
    if (!enabled || !trackUrn || !lyrics?.synced?.length) {
      setMotionHints([]);
      return;
    }

    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      const next = getLyricMotionHintsForTrack(
        trackUrn,
        lyrics as { synced: LyricLine[] | null; plain: string | null; source: LyricsSource },
      );
      if (!cancelled) setMotionHints(next);
    };

    const idleApi = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };

    if (idleApi.requestIdleCallback) {
      const id = idleApi.requestIdleCallback(run, { timeout: 700 });
      return () => {
        cancelled = true;
        idleApi.cancelIdleCallback?.(id);
      };
    }

    const timeoutId = window.setTimeout(run, 40);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [enabled, trackUrn, lyrics]);

  return motionHints;
}

function usePrimeLyricsSearch(
  track: Track | null | undefined,
  visible: boolean,
  reqArtist: string,
  reqTitle: string,
) {
  useEffect(() => {
    if (!visible || !track?.urn) return;
    const timeoutId = window.setTimeout(() => {
      void searchLyrics(
        track.urn,
        reqArtist,
        reqTitle,
        getLyricsSearchOptions(track, reqArtist, reqTitle, getTrackDurationMs(track)),
      ).catch(() => null);
    }, 20);
    return () => window.clearTimeout(timeoutId);
  }, [visible, track, reqArtist, reqTitle]);
}

function usePrefetchNextTrackLyrics(visible: boolean) {
  const queue = usePlayerStore((s) => s.queue);
  const queueIndex = usePlayerStore((s) => s.queueIndex);

  useEffect(() => {
    if (!visible) return;
    const nextTrack = queue[queueIndex + 1];
    if (!nextTrack?.urn) return;
    const timeoutId = window.setTimeout(() => {
      void searchLyrics(
        nextTrack.urn,
        nextTrack.user?.username ?? '',
        nextTrack.title ?? '',
        getLyricsSearchOptions(
          nextTrack,
          nextTrack.user?.username ?? '',
          nextTrack.title ?? '',
          getTrackDurationMs(nextTrack),
        ),
      ).catch(() => null);
    }, 120);
    return () => window.clearTimeout(timeoutId);
  }, [visible, queue, queueIndex]);
}

function useAudioTextWarmup(
  enabled: boolean,
  track: Track | null | undefined,
  reqArtist: string,
  reqTitle: string,
  lyrics: { synced?: LyricLine[] | null } | null | undefined,
) {
  usePrimeLyricsSearch(track, enabled, reqArtist, reqTitle);
  usePrefetchNextTrackLyrics(enabled);
  const motionHints = useWarmLyricMotionHints(
    track?.urn,
    lyrics,
    enabled && Boolean(lyrics?.synced?.length),
  );
  return {
    motionHints,
    hintLabel: enabled ? getAudioTextHintLabel(motionHints) : null,
  };
}

type DisplayLyricLine = LyricLine | { time: number; text: string; isPlaceholder: true };

const PAUSE_MARKER = '\u266A\u266A\u266A';
const NOTE_GRADIENT_DURATION_SEC = 3.2;

function isPauseMarkerText(text: string): boolean {
  const trimmed = String(text || '').trim();
  return trimmed.length === 0 || trimmed === '...' || trimmed === PAUSE_MARKER;
}

function buildDisplayLinesWithPausePlaceholders(lines: LyricLine[]): DisplayLyricLine[] {
  if (!lines || lines.length === 0) return [];

  const result: DisplayLyricLine[] = [];

  for (let i = 0; i < lines.length; i++) {
    const current = lines[i];
    if (!isPauseMarkerText(current.text)) {
      result.push(current);
      continue;
    }

    let runEnd = i;
    while (runEnd + 1 < lines.length && isPauseMarkerText(lines[runEnd + 1].text)) {
      runEnd += 1;
    }

    result.push({
      ...current,
      text: PAUSE_MARKER,
    });

    i = runEnd;
  }

  return result;
}

function getPauseNoteAnimationDelay(time: number): string {
  const safeTime = Number.isFinite(time) ? Math.max(time, 0) : 0;
  const phase =
    ((safeTime % NOTE_GRADIENT_DURATION_SEC) + NOTE_GRADIENT_DURATION_SEC) %
    NOTE_GRADIENT_DURATION_SEC;
  return `-${phase.toFixed(3)}s`;
}

function getPauseNoteAnimationDurationSec(playbackRate: number): number {
  return NOTE_GRADIENT_DURATION_SEC / Math.max(playbackRate, 0.35);
}

const SyncedLyricsWithPlaceholders = React.memo(({ lines }: { lines: LyricLine[] }) => {
  const displayLines = useMemo(() => buildDisplayLinesWithPausePlaceholders(lines), [lines]);

  return <ReleaseSyncedLyricsWithProgress lines={displayLines} />;
});

const ReleaseSyncedLyricsWithProgress = React.memo(
  ({ lines }: { lines: (LyricLine | { time: number; text: string; isPlaceholder: true })[] }) => {
    const playbackRate = usePlayerStore((s) => s.playbackRate);
    const targetFramerate = useSettingsStore((s) => s.targetFramerate);
    const unlockFramerate = useSettingsStore((s) => s.unlockFramerate);
    const noteGradientDurationSec = getPauseNoteAnimationDurationSec(playbackRate);
    const containerRef = useRef<HTMLDivElement>(null);
    const activeRef = useRef(-1);
    const lastScrollTsRef = useRef(0);
    const manualScrollDetachedRef = useRef(false);
    const visualProgressRef = useRef(0);
    const linesRef = useRef(lines);
    const lineElsRef = useRef<HTMLElement[]>([]);
    const lineCharElsRef = useRef<HTMLElement[][]>([]);
    const linePauseBarsRef = useRef<Array<HTMLElement | null>>([]);
    const charVisualsRef = useRef<
      Array<Array<{ progress: number; colorAlpha: number; crest: number; filled: number }>>
    >([]);
    const lineFilledRef = useRef<boolean[]>([]);
    const frameBudgetRef = useRef(getAnimationFrameBudgetMs(targetFramerate, unlockFramerate));
    linesRef.current = lines;
    frameBudgetRef.current = getAnimationFrameBudgetMs(targetFramerate, unlockFramerate);

    const findActiveIndex = (source: typeof lines, time: number): number => {
      let lo = 0;
      let hi = source.length - 1;
      let ans = -1;

      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (source[mid].time <= time + 0.02) {
          ans = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }

      return ans;
    };

    const getLineProgress = (idx: number, time: number) => {
      const currentLine = linesRef.current[idx];
      if (!currentLine) return 0;
      const nextLine = linesRef.current[idx + 1];
      const duration = Math.max(
        (nextLine?.time ?? currentLine.time + 2.4) - currentLine.time,
        0.35,
      );
      return clamp01((time - currentLine.time) / duration);
    };

    const updateLineProgress = (idx: number, progress: number) => {
      const lineEls = lineElsRef.current;
      const current = lineEls[idx];
      if (!current) return;
      const currentLine = linesRef.current[idx];
      const activeChars = lineCharElsRef.current[idx] ?? [];

      current.style.setProperty('--lyric-progress', `${progress * 100}%`);
      current.style.setProperty('--lyric-progress-value', `${progress}`);

      if (currentLine?.text.trim() === PAUSE_MARKER) {
        const progressBar = linePauseBarsRef.current[idx];
        if (progressBar) {
          progressBar.style.width = `${progress * 100}%`;
        }
      }

      if (activeChars.length === 0) return;
      const rawCharCount = Number(current.dataset.charCount ?? `${activeChars.length}`);
      const charCount =
        Number.isFinite(rawCharCount) && rawCharCount > 0 ? rawCharCount : activeChars.length;
      const headPosition = progress * charCount;
      const onsetFactor = getLyricCharOnsetFactor(headPosition);

      activeChars.forEach((charEl, charIndex) => {
        const rawProgress = (headPosition - charIndex - 0.18 + 1.72 * onsetFactor) / 2.9;
        const charProgress = stabilizeCharProgress(rawProgress);
        const easedProgress = charProgress;
        const tailDistance = Math.max(charIndex + 0.35 * onsetFactor - headPosition, 0);
        const tailMix = clamp01(1 - tailDistance / 3.7) * onsetFactor;
        const easedTailMix = tailMix;
        const crestDistance = Math.abs(charIndex - (headPosition - 0.55 * onsetFactor));
        const crestMix = clamp01(1 - crestDistance / 1.58) * onsetFactor;
        const easedCrestMix = crestMix;
        const colorAlpha = 0.2 + easedTailMix * 0.8;
        const filledBase = Math.max(easedProgress, easedTailMix);
        const filledLift = clamp01((filledBase - 0.42) / 0.46);

        charEl.style.setProperty('--char-progress', easedProgress.toFixed(4));
        charEl.style.setProperty('--char-color-alpha', colorAlpha.toFixed(4));
        charEl.style.setProperty('--char-crest', easedCrestMix.toFixed(4));
        charEl.style.setProperty('--char-filled', filledLift.toFixed(4));
        charEl.dataset.charState = filledLift >= 0.995 ? 'filled' : '';
      });
    };

    const applyStates = (idx: number, _prev: number) => {
      const lineEls = lineElsRef.current;

      for (let i = 0; i < lineEls.length; i++) {
        const el = lineEls[i];
        if (!el) continue;

        const currentLine = linesRef.current[i];
        const isPlaceholder =
          currentLine && 'isPlaceholder' in currentLine && currentLine.isPlaceholder;
        const isPauseDisplay = currentLine?.text.trim() === PAUSE_MARKER;

        let state = '';
        let filled = false;
        if (i === idx) {
          state = 'active';
        } else if (i < idx) {
          state = idx - i === 1 ? 'past-near' : 'past';
          filled = true;
        } else if (i > idx) {
          state = i - idx === 1 ? 'next-near' : 'next';
        }

        const stateChanged = el.dataset.state !== state;
        if (stateChanged) {
          el.dataset.state = state;
          if (isPlaceholder) {
            el.classList.toggle('placeholder-active', state === 'active');
          }
        }

        const filledChanged = lineFilledRef.current[i] !== filled;
        lineFilledRef.current[i] = filled;

        if (isPauseDisplay && (stateChanged || filledChanged)) {
          const progressBar = linePauseBarsRef.current[i];
          if (progressBar) {
            progressBar.style.width = filled ? '100%' : '0%';
          }
        }

        if (state !== 'active' && (filledChanged || stateChanged)) {
          const targetLineProgress = filled ? '100%' : '0%';
          const targetLineProgressValue = filled ? '1' : '0';
          if (el.style.getPropertyValue('--lyric-progress') !== targetLineProgress) {
            el.style.setProperty('--lyric-progress', targetLineProgress);
          }
          if (el.style.getPropertyValue('--lyric-progress-value') !== targetLineProgressValue) {
            el.style.setProperty('--lyric-progress-value', targetLineProgressValue);
          }

          const targetProgress = filled ? 1 : 0;
          const targetColorAlpha = filled ? 1 : 0.2;
          const targetFilled = filled ? 1 : 0;
          const chars = lineCharElsRef.current[i] ?? [];
          const visualCache = charVisualsRef.current[i] ?? [];
          if (visualCache.length !== chars.length) {
            charVisualsRef.current[i] = chars.map(() => ({
              progress: Number.NaN,
              colorAlpha: Number.NaN,
              crest: Number.NaN,
              filled: Number.NaN,
            }));
          }
          const settledCache = charVisualsRef.current[i];
          chars.forEach((charEl, charIndex) => {
            const charVisual = settledCache[charIndex] ?? {
              progress: Number.NaN,
              colorAlpha: Number.NaN,
              crest: Number.NaN,
              filled: Number.NaN,
            };
            settledCache[charIndex] = charVisual;
            if (charVisual.progress !== targetProgress) {
              charEl.style.setProperty('--char-progress', `${targetProgress}`);
              charVisual.progress = targetProgress;
            }
            if (charVisual.colorAlpha !== targetColorAlpha) {
              charEl.style.setProperty('--char-color-alpha', `${targetColorAlpha}`);
              charVisual.colorAlpha = targetColorAlpha;
            }
            if (charVisual.crest !== 0) {
              charEl.style.setProperty('--char-crest', '0');
              charVisual.crest = 0;
            }
            if (charVisual.filled !== targetFilled) {
              charEl.style.setProperty('--char-filled', `${targetFilled}`);
              charVisual.filled = targetFilled;
            }
            charEl.dataset.charState = filled ? 'filled' : '';
          });
        }
      }
    };

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      lineElsRef.current = Array.from(container.querySelectorAll<HTMLElement>('.lyric-line'));
      lineCharElsRef.current = lineElsRef.current.map((el) =>
        Array.from(el.querySelectorAll<HTMLElement>('[data-char-index]')),
      );
      linePauseBarsRef.current = lineElsRef.current.map((el) =>
        el.querySelector<HTMLElement>('.pause-progress-bar'),
      );
      charVisualsRef.current = lineCharElsRef.current.map((chars) =>
        chars.map(() => ({
          progress: Number.NaN,
          colorAlpha: Number.NaN,
          crest: Number.NaN,
          filled: Number.NaN,
        })),
      );
      lineFilledRef.current = lineElsRef.current.map(() => false);

      const markManualScroll = () => {
        manualScrollDetachedRef.current = true;
      };

      container.addEventListener('wheel', markManualScroll, { passive: true });
      container.addEventListener('touchstart', markManualScroll, { passive: true });
      container.addEventListener('pointerdown', markManualScroll);

      activeRef.current = -1;
      manualScrollDetachedRef.current = false;

      let rafId = 0;
      let lastFrameTs = 0;

      const tick = (ts: number) => {
        rafId = requestAnimationFrame(tick);
        const lineEls = lineElsRef.current;
        if (!container || lineEls.length === 0) return;
        if (isAppBackgrounded()) return;

        const effectiveBudgetMs = Math.max(frameBudgetRef.current || 0, 50);
        if (ts - lastFrameTs < effectiveBudgetMs) return;
        lastFrameTs = ts;

        const time = getCurrentTime();
        const activeTime = getActiveLyricTime(time);
        const visualTime = getSmoothLyricTime();
        const currentLines = linesRef.current;

        const idx = findActiveIndex(currentLines, activeTime);
        const prev = activeRef.current;
        if (idx !== activeRef.current) {
          activeRef.current = idx;
          visualProgressRef.current = 0;

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
          } else if (idx === -1 && !manualScrollDetachedRef.current) {
            container.scrollTo({ top: 0, behavior: 'auto' });
          }

          applyStates(idx, prev);
        }

        if (idx !== -1) {
          const targetProgress = getLineProgress(idx, visualTime);
          const currentVisualProgress = visualProgressRef.current;
          const diff = targetProgress - currentVisualProgress;
          const smoothFactor =
            diff >= 0 ? (diff > 0.2 || targetProgress > 0.9 ? 0.78 : 0.34) : 0.45;
          const nextVisualProgress = Math.max(
            0,
            Math.min(currentVisualProgress + diff * smoothFactor, 1),
          );
          visualProgressRef.current = nextVisualProgress;
          updateLineProgress(idx, nextVisualProgress);
        }
      };

      rafId = requestAnimationFrame(tick);

      return () => {
        cancelAnimationFrame(rafId);
        container.removeEventListener('wheel', markManualScroll);
        container.removeEventListener('touchstart', markManualScroll);
        container.removeEventListener('pointerdown', markManualScroll);
      };
    }, [lines, targetFramerate, unlockFramerate]);

    return (
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto scrollbar-hide px-12 py-16 relative"
      >
        <div className="flex flex-col gap-2">
          {lines.map((line, i) => {
            const isPlaceholder = 'isPlaceholder' in line && line.isPlaceholder;
            let animatedIndex = 0;
            const displayText = line.text.trim().length === 0 ? PAUSE_MARKER : line.text;
            const isPauseDisplay = displayText === PAUSE_MARKER;
            const totalAnimatedChars = countAnimatedLyricChars(displayText);
            const noteGradientDelay = getPauseNoteAnimationDelay(line.time);
            return (
              <div
                key={`${line.time}-${i}-${isPlaceholder ? 'ph' : 'lyric'}`}
                className={`lyric-line group relative origin-left transition-all duration-500 ease-[var(--ease-apple)] will-change-transform py-2.5 text-[28px] font-bold tracking-tight antialiased text-white/22 ${isPauseDisplay ? 'flex w-full justify-center px-0 pr-0 opacity-40 scale-[0.99] translate-x-0 data-[state=active]:opacity-100 data-[state=active]:scale-[1.01] data-[state=active]:translate-x-0 data-[state=past-near]:opacity-72 data-[state=past-near]:scale-[0.99] data-[state=past-near]:translate-x-0 data-[state=past]:opacity-46 data-[state=past]:scale-[0.985] data-[state=past]:translate-x-0 data-[state=next-near]:opacity-62 data-[state=next-near]:scale-[0.99] data-[state=next-near]:translate-x-0 data-[state=next]:opacity-26 data-[state=next]:scale-[0.98] data-[state=next]:translate-x-0' : 'cursor-pointer pr-12 opacity-40 scale-[0.972] translate-x-0 data-[state=active]:opacity-100 data-[state=active]:scale-[1.02] data-[state=active]:translate-x-0 data-[state=past-near]:opacity-78 data-[state=past-near]:scale-[0.992] data-[state=past-near]:-translate-x-1 data-[state=past]:opacity-48 data-[state=past]:scale-[0.98] data-[state=past]:-translate-x-2 data-[state=next-near]:opacity-66 data-[state=next-near]:scale-[0.988] data-[state=next-near]:translate-x-1.5 data-[state=next]:opacity-28 data-[state=next]:scale-[0.968] data-[state=next]:translate-x-3'}`}
                style={{
                  textRendering: 'optimizeLegibility',
                  ['--lyric-progress' as string]: '0%',
                  ...(isPauseDisplay ? { cursor: 'default' } : {}),
                }}
                data-char-count={isPauseDisplay ? undefined : totalAnimatedChars}
                onClick={() => {
                  if (!isPauseDisplay) {
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
                  }
                }}
              >
                <div
                  className={
                    isPauseDisplay
                      ? 'flex w-28 flex-col items-center'
                      : 'flex w-full flex-col items-start'
                  }
                >
                  {isPauseDisplay ? (
                    <span
                      className="note-gradient-text text-center text-transparent"
                      style={{
                        ['--note-gradient-delay' as string]: noteGradientDelay,
                        ['--note-gradient-duration' as string]: `${noteGradientDurationSec}s`,
                      }}
                    >
                      {displayText}
                    </span>
                  ) : (
                    <span className="block text-left transition-[filter] duration-300 [filter:drop-shadow(0_0_10px_rgba(255,255,255,0.2))] group-data-[state=active]:[filter:drop-shadow(0_0_18px_rgba(255,255,255,0.38))]">
                      {displayText.split(/(\s+)/).map((word, wordIdx, arr) => {
                        const offset = arr.slice(0, wordIdx).join('').length;
                        return (
                          <span
                            key={wordIdx}
                            className="inline-block whitespace-pre-wrap"
                            data-word-index={wordIdx}
                          >
                            {Array.from(word).map((char, charIndex) => {
                              if (!isAnimatedLyricChar(char)) {
                                return <span key={`${wordIdx}-${charIndex}`}>{char}</span>;
                              }

                              const charAnimatedIndex = animatedIndex++;
                              return (
                                <span
                                  key={offset + charIndex}
                                  data-char-index={charAnimatedIndex}
                                  className="relative inline-block transition-[transform,filter,color] duration-180 ease-linear [color:rgba(255,255,255,var(--char-color-alpha,0.2))] [transform:translateY(calc((var(--char-progress,0)*-0.008em)+(var(--char-filled,0)*-0.136em)+(var(--char-crest,0)*-0.024em)))_scale(calc(1+(var(--char-progress,0)*0.002)+(var(--char-filled,0)*0.022)+(var(--char-crest,0)*0.006)))] [filter:drop-shadow(0_0_calc((var(--char-progress,0)*1px)+(var(--char-filled,0)*6px)+(var(--char-crest,0)*4px))_rgba(255,255,255,calc((var(--char-progress,0)*0.02)+(var(--char-filled,0)*0.11)+(var(--char-crest,0)*0.06))))]"
                                  style={{
                                    ['--char-progress' as string]: '0',
                                    ['--char-color-alpha' as string]: '0.2',
                                    ['--char-crest' as string]: '0',
                                    ['--char-filled' as string]: '0',
                                  }}
                                >
                                  <span>{char}</span>
                                </span>
                              );
                            })}
                          </span>
                        );
                      })}
                    </span>
                  )}
                  {isPauseDisplay ? (
                    <div className="mt-3 h-[3px] w-28 overflow-hidden rounded-full bg-white/[0.08]">
                      <div
                        className="pause-progress-bar h-full rounded-full bg-white/70 transition-[width] duration-150 ease-linear"
                        style={{ width: '0%' }}
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        <div className="h-[50vh]" />
      </div>
    );
  },
);

/* ── Synced Lyrics with pause placeholders ───────────────────── */

const ReleaseSyncedLyrics = React.memo(({ lines }: { lines: LyricLine[] }) => (
  <ReleaseSyncedLyricsWithProgress lines={lines} />
));

const SyncedLyricsWithWarmup = React.memo(
  ({
    lines,
  }: {
    lines: LyricLine[];
    motionHints: ReturnType<typeof getLyricMotionHintsForTrack>;
    reactiveEnabled?: boolean;
  }) => {
    return <SyncedLyricsWithPlaceholders lines={lines} />;
  },
);

const SyncedLyricsWithProgress = React.memo(
  ({
    lines,
    motionHints = [],
    reactiveEnabled = true,
  }: {
    lines: (LyricLine | { time: number; text: string; isPlaceholder: true })[];
    motionHints?: Array<{ index: number; importance: number; density: number; onsetBias: number }>;
    reactiveEnabled?: boolean;
  }) => {
    const safeReactiveEnabled = reactiveEnabled;
    const playbackRate = usePlayerStore((s) => s.playbackRate);
    const targetFramerate = useSettingsStore((s) => s.targetFramerate);
    const unlockFramerate = useSettingsStore((s) => s.unlockFramerate);
    const noteGradientDurationSec = getPauseNoteAnimationDurationSec(playbackRate);
    const containerRef = useRef<HTMLDivElement>(null);
    const activeRef = useRef(-1);
    const lastScrollTsRef = useRef(0);
    const manualScrollDetachedRef = useRef(false);
    const visualProgressRef = useRef(0);
    const speedFloorRef = useRef(1);
    const lineActivatedAtRef = useRef(0);
    const linesRef = useRef(lines);
    const motionHintsRef = useRef(motionHints);
    const lineElsRef = useRef<HTMLElement[]>([]);
    const frameBudgetRef = useRef(getAnimationFrameBudgetMs(targetFramerate, unlockFramerate));
    linesRef.current = lines;
    motionHintsRef.current = motionHints;
    frameBudgetRef.current = getAnimationFrameBudgetMs(targetFramerate, unlockFramerate);

    const findActiveIndex = (source: typeof lines, time: number): number => {
      let lo = 0;
      let hi = source.length - 1;
      let ans = -1;

      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (source[mid].time <= time + 0.02) {
          ans = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }

      return ans;
    };

    const getLineProgress = (idx: number, time: number, features: AudioFeatures | null) => {
      if (!safeReactiveEnabled) {
        const currentLine = linesRef.current[idx];
        if (!currentLine) return 0;
        const nextLine = linesRef.current[idx + 1];
        const duration = Math.max(
          (nextLine?.time ?? currentLine.time + 2.4) - currentLine.time,
          0.35,
        );
        return clamp01((time - currentLine.time) / duration);
      }

      const currentLine = linesRef.current[idx];
      if (!currentLine) return 0;
      const nextLine = linesRef.current[idx + 1];
      const rawDuration = Math.max(
        (nextLine?.time ?? currentLine.time + 2.4) - currentLine.time,
        0.35,
      );
      const rawProgress = clamp01((time - currentLine.time) / rawDuration);

      // For regular synced lyrics (without warmup motion hints), keep timing strictly linear.
      const hasReactiveHints = motionHintsRef.current.length > 0;
      const reactiveMode = hasReactiveHints && idx >= 0 && idx < linesRef.current.length - 1;
      if (!reactiveMode) {
        return rawProgress;
      }

      const hintBoost = getMotionHintBoost(motionHintsRef.current, idx);
      const progress = getAnimatedLineProgress(
        linesRef.current,
        idx,
        time,
        reactiveMode,
        features,
        hintBoost,
      );
      const elapsedSinceActivation = Math.max(0, time - lineActivatedAtRef.current);
      const elapsedSinceLineStart = Math.max(0, time - currentLine.time);
      const gatedElapsed = Math.min(elapsedSinceActivation, elapsedSinceLineStart);
      const startupWindow = Math.min(Math.max(rawDuration * 0.18, 0.08), 0.2);

      if (gatedElapsed < startupWindow) {
        const startupCap = clamp01(gatedElapsed / startupWindow) * 0.14;
        return Math.min(progress, startupCap);
      }

      return progress;
    };

    const getStepLineProgress = (idx: number, time: number) => {
      const currentLine = linesRef.current[idx];
      if (!currentLine) return 0;
      const nextLine = linesRef.current[idx + 1];
      const duration = Math.max(
        (nextLine?.time ?? currentLine.time + 2.4) - currentLine.time,
        0.35,
      );
      return clamp01((time - currentLine.time) / duration);
    };

    const syncActiveChars = (activeChars: NodeListOf<HTMLElement>, progress: number) => {
      const charCount = Math.max(activeChars.length, 1);
      const headPosition = progress * charCount;
      const onsetFactor = getLyricCharOnsetFactor(headPosition);
      activeChars.forEach((charEl, charIndex) => {
        const rawProgress =
          (headPosition - charIndex - 0.18 + LYRIC_CURSOR_CHAR_SPAN * 0.66 * onsetFactor) /
          LYRIC_TRAIL_CHAR_SPAN;
        syncLyricCharProgress(charEl, rawProgress);
      });
    };

    const updateStepLineProgress = (idx: number, time: number) => {
      const lineEls = lineElsRef.current;
      const current = lineEls[idx];
      if (!current) return;

      const progress = getStepLineProgress(idx, time);
      const activeChars = current.querySelectorAll<HTMLElement>('[data-char-index]');

      applyLyricProgressStyle(current, progress);
      syncActiveChars(activeChars, progress);
    };

    const applyStepStates = (idx: number, _prev: number) => {
      const lineEls = lineElsRef.current;

      for (let i = 0; i < lineEls.length; i++) {
        const el = lineEls[i];
        if (!el) continue;

        const currentLine = linesRef.current[i];
        const isPlaceholder =
          currentLine && 'isPlaceholder' in currentLine && currentLine.isPlaceholder;
        const isPauseDisplay = isPauseDisplayLine(currentLine);

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
          if (isPlaceholder) {
            el.classList.toggle('placeholder-active', state === 'active');
          }
        }

        const progressChanged = el.style.getPropertyValue('--lyric-progress') !== progress;
        if (progressChanged) {
          el.style.setProperty('--lyric-progress', progress);
        }

        if (isPauseDisplay && (stateChanged || progressChanged)) {
          const progressBar = el.querySelector('.pause-progress-bar') as HTMLElement | null;
          if (progressBar) {
            progressBar.style.width = progress;
          }
        }

        if (state !== 'active' && (stateChanged || progressChanged)) {
          applyLyricProgressStyle(el, progress === '100%' ? 1 : 0);
          el.querySelectorAll<HTMLElement>('[data-char-index]').forEach((charEl) => {
            syncLyricCharProgress(charEl, progress === '100%' ? 1 : 0);
          });
        }
      }
    };

    const applyVisualStates = (idx: number, prev: number) =>
      safeReactiveEnabled ? applyStates(idx, prev) : applyStepStates(idx, prev);
    const getVisualTime = () => getSmoothLyricTime();
    const getVisualProgress = (idx: number, time: number, features: AudioFeatures | null) =>
      safeReactiveEnabled ? getLineProgress(idx, time, features) : getStepLineProgress(idx, time);

    const getCurrentFeatures = () => {
      if (!safeReactiveEnabled) return null;
      try {
        return audioAnalyser.getCurrentFeatures();
      } catch {
        return null;
      }
    };
    const buildFlooredFeatures = (currentFeatures: AudioFeatures | null) => {
      if (!safeReactiveEnabled) return null;
      const activeLine = activeRef.current >= 0 ? linesRef.current[activeRef.current] : null;
      const rapBoost = getRapLineBoost(activeLine?.text);
      const reactiveDrive = getReactiveLyricDrive(currentFeatures, rapBoost);
      speedFloorRef.current = Math.max(
        1,
        reactiveDrive.speedMultiplier,
        getMotionHintFloor(motionHintsRef.current),
        1 + rapBoost * 0.18,
        speedFloorRef.current * (currentFeatures ? 0.988 : 0.982),
      );
      const activeHintBoost =
        activeRef.current >= 0 ? getMotionHintBoost(motionHintsRef.current, activeRef.current) : 0;
      const flooredFeatures = currentFeatures
        ? {
            ...currentFeatures,
            flux: Math.max(
              currentFeatures.flux,
              (speedFloorRef.current - 1) * 0.036 + activeHintBoost * 0.024 + rapBoost * 0.018,
            ),
            midPresence: Math.max(
              currentFeatures.midPresence ?? 0,
              (speedFloorRef.current - 1) * 0.56 + activeHintBoost * 0.2 + rapBoost * 0.18,
            ),
            dynamicRange: Math.max(
              currentFeatures.dynamicRange ?? 0,
              (speedFloorRef.current - 1) * 0.72 + activeHintBoost * 0.11 + rapBoost * 0.08,
            ),
            arousal: Math.max(
              currentFeatures.arousal,
              clamp01(
                (speedFloorRef.current - 1) / 0.62 + activeHintBoost * 0.16 + rapBoost * 0.14,
              ),
            ),
            bpm: Math.max(currentFeatures.bpm || 0, 88 + rapBoost * 74),
          }
        : null;

      if (!currentFeatures && rapBoost > 0.1) {
        speedFloorRef.current = Math.max(speedFloorRef.current, 1 + rapBoost * 0.14);
      }

      return flooredFeatures;
    };

    const applyReactiveVisualProgress = (
      idx: number,
      time: number,
      features: AudioFeatures | null,
    ) => {
      const targetProgress = getVisualProgress(idx, time, features);
      const currentVisualProgress = visualProgressRef.current;
      const diff = targetProgress - currentVisualProgress;
      const justActivated = time - lineActivatedAtRef.current < 0.18;
      const smoothFactor =
        diff >= 0 ? (justActivated ? 0.28 : diff > 0.2 || targetProgress > 0.9 ? 0.8 : 0.38) : 0.36;
      const nextVisualProgress = Math.max(
        currentVisualProgress,
        Math.min(currentVisualProgress + diff * smoothFactor, 1),
      );
      visualProgressRef.current = nextVisualProgress;
      updateLineProgress(idx, nextVisualProgress);
    };

    const applyTimedVisualProgress = (idx: number, time: number) => {
      updateStepLineProgress(idx, time);
    };

    const applyProgressTick = safeReactiveEnabled
      ? (idx: number, time: number, features: AudioFeatures | null) =>
          applyReactiveVisualProgress(idx, time, features)
      : (idx: number, time: number) => applyTimedVisualProgress(idx, time);

    const isPauseDisplayLine = (
      line: (LyricLine | { time: number; text: string; isPlaceholder: true }) | undefined,
    ) => {
      if (!line) return false;
      const text = line.text.trim();
      return text.length === 0 || text === '♪♪♪' || text === '...';
    };

    const updateLineProgress = (idx: number, progress: number) => {
      const lineEls = lineElsRef.current;
      const current = lineEls[idx];
      if (!current) return;

      const currentLine = linesRef.current[idx];
      const activeChars = current.querySelectorAll<HTMLElement>('[data-char-index]');

      applyLyricProgressStyle(current, progress);
      syncActiveChars(activeChars, progress);

      if (isPauseDisplayLine(currentLine)) {
        const progressBar = current.querySelector('.pause-progress-bar') as HTMLElement | null;
        if (progressBar) {
          progressBar.style.width = `${progress * 100}%`;
        }
      }
    };

    const applyStates = (idx: number, _prev: number) => {
      const lineEls = lineElsRef.current;

      for (let i = 0; i < lineEls.length; i++) {
        const el = lineEls[i];
        if (!el) continue;

        const currentLine = linesRef.current[i];
        const isPlaceholder =
          currentLine && 'isPlaceholder' in currentLine && currentLine.isPlaceholder;
        const isPauseDisplay = isPauseDisplayLine(currentLine);

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
          if (isPlaceholder) {
            el.classList.toggle('placeholder-active', state === 'active');
          }
        }

        const progressChanged = el.style.getPropertyValue('--lyric-progress') !== progress;
        if (progressChanged) {
          el.style.setProperty('--lyric-progress', progress);
        }

        if (isPauseDisplay && (stateChanged || progressChanged)) {
          const progressBar = el.querySelector('.pause-progress-bar') as HTMLElement | null;
          if (progressBar) {
            progressBar.style.width = progress;
          }
        }

        if (state !== 'active' && (stateChanged || progressChanged)) {
          applyLyricProgressStyle(el, progress === '100%' ? 1 : 0);
          el.querySelectorAll<HTMLElement>('[data-char-index]').forEach((charEl) => {
            syncLyricCharProgress(charEl, progress === '100%' ? 1 : 0);
          });
        }
      }
    };

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
      speedFloorRef.current = 1;
      lineActivatedAtRef.current = 0;

      let rafId = 0;
      let lastFrameTs = 0;

      const tick = (ts: number) => {
        rafId = requestAnimationFrame(tick);
        const lineEls = lineElsRef.current;
        if (!container || lineEls.length === 0) return;
        if (isAppBackgrounded()) return;

        const frameBudgetMs = frameBudgetRef.current;
        if (frameBudgetMs > 0 && ts - lastFrameTs < frameBudgetMs) return;
        lastFrameTs = ts;

        const time = getCurrentTime();
        const activeTime = getActiveLyricTime(time);
        const visualTime = getVisualTime();
        const currentLines = linesRef.current;
        const currentFeatures = getCurrentFeatures();
        const flooredFeatures = buildFlooredFeatures(currentFeatures);

        const idx = findActiveIndex(currentLines, activeTime);
        const prev = activeRef.current;
        if (idx !== activeRef.current) {
          activeRef.current = idx;
          lineActivatedAtRef.current = visualTime;
          visualProgressRef.current = 0;

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
          } else if (idx === -1 && !manualScrollDetachedRef.current) {
            container.scrollTo({ top: 0, behavior: 'auto' });
          }

          applyVisualStates(idx, prev);
        }

        if (idx !== -1) {
          applyProgressTick(idx, visualTime, flooredFeatures);
        }
      };

      rafId = requestAnimationFrame(tick);

      return () => {
        cancelAnimationFrame(rafId);
        container.removeEventListener('wheel', markManualScroll);
        container.removeEventListener('touchstart', markManualScroll);
        container.removeEventListener('pointerdown', markManualScroll);
      };
    }, [lines, motionHints, targetFramerate, unlockFramerate]);

    return (
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto scrollbar-hide px-12 py-16 relative"
      >
        <div className="flex flex-col gap-2">
          {lines.map((line, i) => {
            const isPlaceholder = 'isPlaceholder' in line && line.isPlaceholder;
            let animatedIndex = 0;
            const displayText = line.text.trim().length === 0 ? '♪♪♪' : line.text;
            const isPauseDisplay = displayText === '♪♪♪';
            const totalAnimatedChars = Array.from(displayText).filter(
              (char) => !/^\s+$/.test(char),
            ).length;
            return (
              <div
                key={`${line.time}-${i}-${isPlaceholder ? 'ph' : 'lyric'}`}
                className={`lyric-line group relative origin-left transition-all duration-500 ease-[var(--ease-apple)] will-change-transform py-2.5 text-[28px] font-bold tracking-tight antialiased text-white/22 ${isPauseDisplay ? 'flex w-full justify-center px-0 pr-0 opacity-40 scale-[0.99] translate-x-0 data-[state=active]:opacity-100 data-[state=active]:scale-[1.01] data-[state=active]:translate-x-0 data-[state=past-near]:opacity-72 data-[state=past-near]:scale-[0.99] data-[state=past-near]:translate-x-0 data-[state=past]:opacity-46 data-[state=past]:scale-[0.985] data-[state=past]:translate-x-0 data-[state=next-near]:opacity-62 data-[state=next-near]:scale-[0.99] data-[state=next-near]:translate-x-0 data-[state=next]:opacity-26 data-[state=next]:scale-[0.98] data-[state=next]:translate-x-0' : 'cursor-pointer pr-12 opacity-40 scale-[0.972] translate-x-0 data-[state=active]:opacity-100 data-[state=active]:scale-[1.02] data-[state=active]:translate-x-0 data-[state=past-near]:opacity-78 data-[state=past-near]:scale-[0.992] data-[state=past-near]:-translate-x-1 data-[state=past]:opacity-48 data-[state=past]:scale-[0.98] data-[state=past]:-translate-x-2 data-[state=next-near]:opacity-66 data-[state=next-near]:scale-[0.988] data-[state=next-near]:translate-x-1.5 data-[state=next]:opacity-28 data-[state=next]:scale-[0.968] data-[state=next]:translate-x-3'}`}
                style={{
                  textRendering: 'optimizeLegibility',
                  ['--lyric-progress' as string]: '0%',
                  ['--lyric-progress-value' as string]: '0',
                  ['--lyric-tail-start' as string]: '0',
                  ['--lyric-tail-end' as string]: '0',
                  ['--lyric-cursor-start' as string]: '0',
                  ['--lyric-cursor-end' as string]: '0',
                  ['--lyric-cursor-opacity' as string]: '0',
                  ...(isPauseDisplay ? { cursor: 'default' } : {}),
                }}
                data-char-count={isPauseDisplay ? undefined : totalAnimatedChars}
                onClick={() => {
                  if (!isPauseDisplay) {
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
                  }
                }}
              >
                <div
                  className={
                    isPauseDisplay
                      ? 'flex w-28 flex-col items-center'
                      : 'flex w-full flex-col items-start'
                  }
                >
                  {isPauseDisplay ? (
                    <span
                      className="note-gradient-text text-center text-transparent"
                      style={{
                        ['--note-gradient-delay' as string]: getPauseNoteAnimationDelay(line.time),
                        ['--note-gradient-duration' as string]: `${noteGradientDurationSec}s`,
                      }}
                    >
                      {displayText}
                    </span>
                  ) : (
                    <span className="relative block text-left transition-[filter] duration-300 [filter:drop-shadow(0_0_10px_rgba(255,255,255,0.14))] group-data-[state=active]:[filter:drop-shadow(0_0_26px_rgba(255,255,255,0.26))]">
                      <span
                        className="relative block whitespace-pre-wrap"
                        style={{
                          clipPath: 'inset(0 0 0 var(--lyric-progress))',
                          WebkitClipPath: 'inset(0 0 0 var(--lyric-progress))',
                        }}
                      >
                        {displayText.split(/(\s+)/).map((word, wordIdx, arr) => {
                          const offset = arr.slice(0, wordIdx).join('').length;
                          return (
                            <span
                              key={wordIdx}
                              className="inline-block whitespace-pre-wrap"
                              data-word-index={wordIdx}
                            >
                              {Array.from(word).map((char, charIndex) => {
                                if (/^\s+$/.test(char)) {
                                  return <span key={`${wordIdx}-${charIndex}`}>{char}</span>;
                                }

                                const charAnimatedIndex = animatedIndex++;
                                return (
                                  <span
                                    key={offset + charIndex}
                                    data-char-index={charAnimatedIndex}
                                    className="relative inline-block will-change-[transform,filter,color] [color:rgba(255,255,255,calc(0.18+var(--char-progress,0)*0.03))] [transform:translateY(calc(var(--char-progress,0)*-0.065em))_scale(calc(1+var(--char-progress,0)*0.018))] [filter:drop-shadow(0_0_calc(var(--char-progress,0)*5px)_rgba(255,255,255,calc(var(--char-progress,0)*0.06)))]"
                                    style={{ ['--char-progress' as string]: '0' }}
                                  >
                                    {char}
                                  </span>
                                );
                              })}
                            </span>
                          );
                        })}
                      </span>
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap text-white/95"
                        style={{
                          width: 'var(--lyric-progress)',
                          textShadow:
                            '0 0 16px rgba(255,255,255,0.3), 0 0 34px rgba(255,255,255,0.14)',
                        }}
                      >
                        <span className="inline whitespace-pre-wrap">{displayText}</span>
                      </span>
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-0 whitespace-pre-wrap text-transparent opacity-0 transition-opacity duration-100 group-data-[state=active]:opacity-100"
                        style={{
                          clipPath:
                            'inset(0 calc((1 - var(--lyric-tail-end, 0)) * 100%) 0 calc(var(--lyric-tail-start, 0) * 100%))',
                          WebkitClipPath:
                            'inset(0 calc((1 - var(--lyric-tail-end, 0)) * 100%) 0 calc(var(--lyric-tail-start, 0) * 100%))',
                        }}
                      >
                        <span className="inline whitespace-pre-wrap bg-[linear-gradient(90deg,rgba(255,255,255,1)_0%,rgba(255,255,255,0.98)_26%,rgba(255,255,255,0.78)_68%,rgba(255,255,255,0.34)_100%)] bg-clip-text text-transparent [text-shadow:0_0_18px_rgba(255,255,255,0.18)]">
                          {displayText}
                        </span>
                      </span>
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-0 whitespace-pre-wrap text-transparent opacity-0 transition-opacity duration-100 group-data-[state=active]:opacity-100"
                        style={{
                          opacity: 'var(--lyric-cursor-opacity)',
                          clipPath:
                            'inset(0 calc((1 - var(--lyric-cursor-end, 0)) * 100%) 0 calc(var(--lyric-cursor-start, 0) * 100%))',
                          WebkitClipPath:
                            'inset(0 calc((1 - var(--lyric-cursor-end, 0)) * 100%) 0 calc(var(--lyric-cursor-start, 0) * 100%))',
                        }}
                      >
                        <span className="inline whitespace-pre-wrap bg-[linear-gradient(90deg,rgba(255,255,255,0)_0%,rgba(255,255,255,0.92)_52%,rgba(255,255,255,0)_100%)] bg-clip-text text-transparent [filter:drop-shadow(0_0_16px_rgba(255,255,255,0.42))]">
                          {displayText}
                        </span>
                      </span>
                    </span>
                  )}
                  {isPauseDisplay ? (
                    <div className="mt-3 h-[3px] w-28 overflow-hidden rounded-full bg-white/[0.08]">
                      <div
                        className="pause-progress-bar h-full rounded-full bg-white/70 transition-[width] duration-150 ease-linear"
                        style={{ width: '0%' }}
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        <div className="h-[50vh]" />
      </div>
    );
  },
);

void SyncedLyricsWithProgress;

/* ── Synced Lyrics ─ CSS data-state + DOM scroll, 0 re-renders */

export const SyncedLyrics = React.memo(({ lines }: { lines: LyricLine[] }) => (
  <ReleaseSyncedLyrics lines={lines} />
));

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

const StaticSyncedLyrics = React.memo(({ lines }: { lines: LyricLine[] }) => {
  const playbackRate = usePlayerStore((s) => s.playbackRate);
  const displayLines = useMemo(() => buildDisplayLinesWithPausePlaceholders(lines), [lines]);
  const noteGradientDurationSec = getPauseNoteAnimationDurationSec(playbackRate);

  return (
    <div
      className="flex-1 overflow-y-auto scrollbar-hide px-12 py-16"
      style={{
        maskImage: 'linear-gradient(transparent 0%, black 10%, black 90%, transparent 100%)',
      }}
    >
      <div className="flex flex-col gap-2">
        {displayLines.map((line, i) => {
          const displayText = line.text.trim().length === 0 ? PAUSE_MARKER : line.text;
          const isPauseDisplay = displayText === PAUSE_MARKER;
          const noteGradientDelay = getPauseNoteAnimationDelay(line.time);

          return (
            <div
              key={`${line.time}-${i}-static`}
              className={isPauseDisplay ? 'flex w-full justify-center py-4 opacity-75' : 'py-2.5'}
            >
              {isPauseDisplay ? (
                <div className="flex w-28 flex-col items-center">
                  <span
                    className="note-gradient-text text-center text-transparent"
                    style={{
                      ['--note-gradient-delay' as string]: noteGradientDelay,
                      ['--note-gradient-duration' as string]: `${noteGradientDurationSec}s`,
                    }}
                  >
                    {displayText}
                  </span>
                  <div className="mt-3 h-[3px] w-28 rounded-full bg-white/[0.12]" />
                </div>
              ) : (
                <span className="block text-[28px] font-bold tracking-tight text-white/58">
                  {displayText}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="h-[50vh]" />
    </div>
  );
});

/* ── Lyrics Panel (fullscreen, 50/50) ─────────────────────── */

const LYRICS_PANEL_SPLIT_MIN = 0.32;
const LYRICS_PANEL_SPLIT_MAX = 0.68;
const LYRICS_PANEL_SPLIT_KEYBOARD_STEP = 0.03;
const LYRICS_PANEL_SPLIT_DEFAULT = 0.5;

function clampLyricsPanelSplitRatio(value: number) {
  return Math.max(LYRICS_PANEL_SPLIT_MIN, Math.min(LYRICS_PANEL_SPLIT_MAX, value));
}

export const LyricsPanel = React.memo(
  ({
    forceOpen = false,
    panelClassName = '',
    panelStyle,
    live = true,
  }: {
    forceOpen?: boolean;
    panelClassName?: string;
    panelStyle?: React.CSSProperties;
    live?: boolean;
  }) => {
    const open = useLyricsStore((s) => s.open);
    const visible = forceOpen || open;
    const interactiveVisible = visible && live;
    const close = useLyricsStore((s) => s.close);
    const openAnimation = useFullscreenPanelStore((s) => s.openAnimation);
    const closeAnimation = useFullscreenPanelStore((s) => s.closeAnimation);
    const track = usePlayerStore((s) => s.currentTrack);
    const visualizerFullscreen = useSettingsStore((s) => s.visualizerFullscreen);
    const { t } = useTranslation();
    const artworkColor = useArtworkColor(track?.artwork_url ?? null);
    const lyricsSplitRatio = useFullscreenPanelStore((s) => s.lyricsSplitRatio);
    const setLyricsSplitRatio = useFullscreenPanelStore((s) => s.setLyricsSplitRatio);

    const [isEditing, setIsEditing] = useState(false);
    const [manualQuery, setManualQuery] = useState<{ artist: string; title: string } | null>(null);
    const [editArtist, setEditArtist] = useState('');
    const [editTitle, setEditTitle] = useState('');
    const [isResizingSplit, setIsResizingSplit] = useState(false);
    const splitLayoutRef = useRef<HTMLDivElement>(null);
    const splitDraggingRef = useRef(false);

    const reqArtist = manualQuery ? manualQuery.artist : (track?.user.username ?? '');
    const reqTitle = manualQuery ? manualQuery.title : (track?.title ?? '');
    const experimentalRuAudioTextWarmup = useSettingsStore((s) => s.experimentalRuAudioTextWarmup);
    const {
      data: lyrics,
      isLoading,
      pseudoSynced,
      generatedFromPlain,
    } = useResolvedLyrics(
      interactiveVisible,
      track,
      reqArtist,
      reqTitle,
      getTrackDurationMs(track),
      experimentalRuAudioTextWarmup,
    );
    const warmupEnabled = interactiveVisible && generatedFromPlain && experimentalRuAudioTextWarmup;
    const { motionHints, hintLabel } = useAudioTextWarmup(
      warmupEnabled,
      track,
      reqArtist,
      reqTitle,
      lyrics,
    );

    // biome-ignore lint/correctness/useExhaustiveDependencies: reset editor state only on track switch
    useEffect(() => {
      setManualQuery(null);
      setIsEditing(false);
    }, [track?.urn]);

    useEffect(() => {
      if (!interactiveVisible) return;
      const handler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') close();
      };
      window.addEventListener('keydown', handler);
      return () => window.removeEventListener('keydown', handler);
    }, [interactiveVisible, close]);

    useEffect(() => {
      if (!isResizingSplit) return;

      const prevCursor = document.body.style.cursor;
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      return () => {
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevUserSelect;
      };
    }, [isResizingSplit]);

    useEffect(() => {
      if (!interactiveVisible && splitDraggingRef.current) {
        splitDraggingRef.current = false;
        setIsResizingSplit(false);
      }
    }, [interactiveVisible]);

    if (!visible || !track) return null;

    const artwork500 = art(track.artwork_url, 't500x500');
    const splitPercent = lyricsSplitRatio * 100;
    const updateLyricsSplitFromClientX = (clientX: number) => {
      const layout = splitLayoutRef.current;
      if (!layout) return;
      const rect = layout.getBoundingClientRect();
      if (rect.width <= 0) return;
      const nextRatio = clampLyricsPanelSplitRatio((clientX - rect.left) / rect.width);
      setLyricsSplitRatio(nextRatio);
    };
    const stopSplitDragging = () => {
      splitDraggingRef.current = false;
      setIsResizingSplit(false);
    };
    const rootClassName = forceOpen
      ? `fixed inset-0 z-[60] flex flex-col overflow-hidden bg-[#08080a] ${openAnimation === 'fromMiniPlayer' ? 'animate-fullscreen-from-player' : ''} ${closeAnimation === 'toMiniPlayer' ? 'animate-fullscreen-to-player' : ''} ${panelClassName}`.trim()
      : 'fixed inset-0 z-[60] flex flex-col overflow-hidden animate-fade-in-up bg-[#08080a]';

    return (
      <div className={rootClassName} style={panelStyle}>
        <FullscreenBackground
          key={artwork500 ?? track.urn}
          artworkSrc={artwork500}
          color={artworkColor}
        />

        <div className="absolute top-6 left-6 z-20 pointer-events-none">
          <StreamQualityBadge
            quality={track.streamQuality}
            codec={track.streamCodec}
            access={track.access}
            className="backdrop-blur-sm"
          />
        </div>

        {/* Close */}
        <div
          className="relative z-10 flex justify-end items-center gap-2 px-6 pt-5 pb-2"
          data-tauri-drag-region
        >
          <button
            type="button"
            onClick={() => {
              useLyricsStore.setState({ open: false });
              useFullscreenPanelStore.getState().setOpenAnimation('default');
              useFullscreenPanelStore.getState().setTransitionDirection('toArtwork');
              useFullscreenPanelStore.getState().setMode('artwork');
              setTimeout(
                () => useFullscreenPanelStore.getState().setTransitionDirection('none'),
                500,
              );
              useArtworkStore.setState({ open: true });
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
          ref={splitLayoutRef}
          className={`relative z-10 grid flex-1 min-h-0 ${isResizingSplit ? 'select-none' : ''}`}
          style={{
            isolation: 'isolate',
            gridTemplateColumns: `${splitPercent}% ${100 - splitPercent}%`,
          }}
        >
          <div className="min-w-0 min-h-0">
            <TrackColumn track={track} />
          </div>

          {/* Divider */}
          <div
            role="separator"
            aria-label={t('track.resizeLayout', 'Resize layout')}
            aria-orientation="vertical"
            aria-valuemin={Math.round(LYRICS_PANEL_SPLIT_MIN * 100)}
            aria-valuemax={Math.round(LYRICS_PANEL_SPLIT_MAX * 100)}
            aria-valuenow={Math.round(splitPercent)}
            tabIndex={interactiveVisible ? 0 : -1}
            className="group/splitter absolute top-0 bottom-0 z-20 w-6 -translate-x-1/2 touch-none cursor-col-resize outline-none"
            style={{ left: `${splitPercent}%` }}
            onPointerDown={(event) => {
              if (!interactiveVisible) return;
              event.preventDefault();
              splitDraggingRef.current = true;
              setIsResizingSplit(true);
              event.currentTarget.setPointerCapture(event.pointerId);
              updateLyricsSplitFromClientX(event.clientX);
            }}
            onDoubleClick={(event) => {
              event.preventDefault();
              splitDraggingRef.current = false;
              setIsResizingSplit(false);
              setLyricsSplitRatio(LYRICS_PANEL_SPLIT_DEFAULT);
            }}
            onPointerMove={(event) => {
              if (!splitDraggingRef.current) return;
              updateLyricsSplitFromClientX(event.clientX);
            }}
            onPointerUp={stopSplitDragging}
            onPointerCancel={stopSplitDragging}
            onLostPointerCapture={stopSplitDragging}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                setLyricsSplitRatio(
                  clampLyricsPanelSplitRatio(lyricsSplitRatio - LYRICS_PANEL_SPLIT_KEYBOARD_STEP),
                );
              } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                setLyricsSplitRatio(
                  clampLyricsPanelSplitRatio(lyricsSplitRatio + LYRICS_PANEL_SPLIT_KEYBOARD_STEP),
                );
              }
            }}
          >
            <div
              className={`absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 transition-colors duration-150 ${
                isResizingSplit ? 'bg-white/20' : 'bg-white/[0.04] group-hover/splitter:bg-white/10'
              }`}
            />
            <div
              className={`absolute left-1/2 top-1/2 flex h-14 w-3 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border transition-all duration-150 ${
                isResizingSplit
                  ? 'border-white/18 bg-white/[0.12] shadow-[0_0_20px_rgba(255,255,255,0.08)]'
                  : 'border-white/[0.08] bg-white/[0.04] group-hover/splitter:border-white/14 group-hover/splitter:bg-white/[0.08]'
              }`}
            >
              <div className="flex flex-col gap-1.5">
                <span className="block h-1 w-[2px] rounded-full bg-white/35" />
                <span className="block h-1 w-[2px] rounded-full bg-white/35" />
                <span className="block h-1 w-[2px] rounded-full bg-white/35" />
              </div>
            </div>
          </div>

          {/* Right: lyrics */}
          <div className="min-w-0 min-h-0 flex flex-col relative">
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
            ) : interactiveVisible && isLoading ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-3">
                <Loader2 size={24} className="animate-spin text-white/15" />
                <p className="text-[13px] text-white/25">{t('track.lyricsLoading')}</p>
              </div>
            ) : shouldRenderSyncedLyrics(lyrics) ? (
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
                {shouldShowPseudoSyncHint(lyrics, pseudoSynced) ? <PseudoSyncHint /> : null}
                {warmupEnabled ? <AudioTextWarmupHint label={hintLabel} /> : null}
                {interactiveVisible ? (
                  <SyncedLyricsWithWarmup
                    lines={lyrics.synced}
                    motionHints={warmupEnabled ? motionHints : []}
                    reactiveEnabled
                  />
                ) : (
                  <StaticSyncedLyrics lines={lyrics.synced} />
                )}
              </>
            ) : shouldRenderPlainLyrics(lyrics) ? (
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

        {live && <FloatingComments />}
        {live && visualizerFullscreen && <FullscreenVisualizer />}
      </div>
    );
  },
);

/* ── Artwork Fullscreen Panel ─────────────────────────────── */

export const ArtworkPanel = React.memo(
  ({
    forceOpen = false,
    panelClassName = '',
    panelStyle,
    live = true,
  }: {
    forceOpen?: boolean;
    panelClassName?: string;
    panelStyle?: React.CSSProperties;
    live?: boolean;
  }) => {
    const { t } = useTranslation();
    const open = useArtworkStore((s) => s.open);
    const visible = forceOpen || open;
    const interactiveVisible = visible && live;
    const setOpen = useArtworkStore((s) => s.setOpen);
    const openLyrics = useLyricsStore((s) => s.openPanel);
    const openAnimation = useFullscreenPanelStore((s) => s.openAnimation);
    const closeAnimation = useFullscreenPanelStore((s) => s.closeAnimation);
    const track = usePlayerStore((s) => s.currentTrack);
    const visualizerFullscreen = useSettingsStore((s) => s.visualizerFullscreen);
    const artworkColor = useArtworkColor(track?.artwork_url ?? null);

    useEffect(() => {
      if (!interactiveVisible) return;
      const handler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') setOpen(false);
      };
      window.addEventListener('keydown', handler);
      return () => window.removeEventListener('keydown', handler);
    }, [interactiveVisible, setOpen]);

    if (!visible || !track) return null;

    const artwork500 = art(track.artwork_url, 't500x500');
    const rootClassName = forceOpen
      ? `fixed inset-0 z-[60] flex flex-col overflow-hidden bg-[#08080a] ${openAnimation === 'fromMiniPlayer' ? 'animate-fullscreen-from-player' : ''} ${closeAnimation === 'toMiniPlayer' ? 'animate-fullscreen-to-player' : ''} ${panelClassName}`.trim()
      : 'fixed inset-0 z-[60] flex flex-col overflow-hidden animate-fade-in-up bg-[#08080a]';

    return (
      <div className={rootClassName} style={panelStyle}>
        <FullscreenBackground
          key={artwork500 ?? track.urn}
          artworkSrc={artwork500}
          color={artworkColor}
        />

        <div className="absolute top-6 left-6 z-20 pointer-events-none">
          <StreamQualityBadge
            quality={track.streamQuality}
            codec={track.streamCodec}
            access={track.access}
            className="backdrop-blur-sm"
          />
        </div>

        {/* Close */}
        <div
          className="relative z-10 flex justify-end items-center gap-2 px-6 pt-5 pb-2"
          data-tauri-drag-region
        >
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

        {live && <FloatingComments mode="sidebar" />}
        {live && visualizerFullscreen && <FullscreenVisualizer />}
      </div>
    );
  },
);

/** Imperative API so NowPlayingBar can open without prop drilling */
export const artworkPanelApi = {
  open: () => useArtworkStore.getState().setOpen(true),
  openFromMiniPlayer: () => useArtworkStore.getState().openFromMiniPlayer(),
  close: () => useArtworkStore.getState().setOpen(false),
};

/* ── Fullscreen Panels ─────────────────────────────────────── */

const FullscreenPanels = React.memo(() => {
  const mode = useFullscreenPanelStore((s) => s.mode);
  const transitionDirection = useFullscreenPanelStore((s) => s.transitionDirection);
  const closeAnimation = useFullscreenPanelStore((s) => s.closeAnimation);
  const [artworkX, setArtworkX] = useState('0%');
  const [lyricsX, setLyricsX] = useState('100%');
  const isSliding = transitionDirection !== 'none';
  const liveMode =
    transitionDirection === 'toLyrics'
      ? 'lyrics'
      : transitionDirection === 'toArtwork'
        ? 'artwork'
        : mode;

  useEffect(() => {
    if (transitionDirection === 'toLyrics') {
      setArtworkX('0%');
      setLyricsX('100%');
      const raf = requestAnimationFrame(() => {
        setArtworkX('-100%');
        setLyricsX('0%');
      });
      return () => cancelAnimationFrame(raf);
    }

    if (transitionDirection === 'toArtwork') {
      setArtworkX('-100%');
      setLyricsX('0%');
      const raf = requestAnimationFrame(() => {
        setArtworkX('0%');
        setLyricsX('100%');
      });
      return () => cancelAnimationFrame(raf);
    }

    setArtworkX(mode === 'artwork' ? '0%' : '-100%');
    setLyricsX(mode === 'lyrics' ? '0%' : '100%');
  }, [mode, transitionDirection]);

  if (mode === 'none') return null;

  if (!isSliding || closeAnimation !== 'none') {
    return mode === 'artwork' ? <ArtworkPanel forceOpen /> : <LyricsPanel forceOpen />;
  }

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      <ArtworkPanel
        forceOpen
        live={liveMode === 'artwork'}
        panelClassName="transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"
        panelStyle={{ transform: `translateX(${artworkX})` }}
      />
      <LyricsPanel
        forceOpen
        live={liveMode === 'lyrics'}
        panelClassName="transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"
        panelStyle={{ transform: `translateX(${lyricsX})` }}
      />
    </div>
  );
});

export { FullscreenPanels };
