import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { listCachedUrns, listCachedLyricsUrns, removeLyricsForTrack } from '../lib/cache';
import { art, dur } from '../lib/formatters';
import { fetchAllLikedTracks, invalidateAllLikesCache } from '../lib/hooks';
import {
  AlertCircle,
  Download,
  Globe,
  Heart,
  Music,
  Play,
  RotateCcw,
  Settings,
} from '../lib/icons';
import {
  getOfflineIndexUpdatedAt,
  getOfflineLikedTracks,
  getOfflineTracksByUrns,
} from '../lib/offline-index';
import { type AppMode, useAppStatusStore } from '../stores/app-status';
import type { Track } from '../stores/player';
import { usePlayerStore } from '../stores/player';

interface OfflineLibraryState {
  likedTracks: Track[];
  cachedTracks: Track[];
  cachedUrns: Set<string>;
  cachedLyricsUrns: Set<string>;
  updatedAt: number | null;
}

const EMPTY_STATE: OfflineLibraryState = {
  likedTracks: [],
  cachedTracks: [],
  cachedUrns: new Set(),
  cachedLyricsUrns: new Set(),
  updatedAt: null,
};

function resolveMode(state: {
  soundcloudBlocked: boolean;
  navigatorOnline: boolean;
  backendReachable: boolean;
}): AppMode {
  if (state.soundcloudBlocked) return 'blocked';
  if (!state.navigatorOnline || !state.backendReachable) return 'offline';
  return 'online';
}

const OfflineTrackRow = React.memo(function OfflineTrackRow({
  track,
  queue,
  canPlay,
  cached,
  lyricsCached,
  onClearLyrics,
}: {
  track: Track;
  queue: Track[];
  canPlay: boolean;
  cached: boolean;
  lyricsCached: boolean;
  onClearLyrics: (urn: string) => void;
}) {
  const { t } = useTranslation();
  const play = usePlayerStore((s) => s.play);
  const artwork = art(track.artwork_url, 't200x200');

  return (
    <div
      className={`group flex items-center gap-3 rounded-2xl border px-3 py-2.5 transition-all duration-200 ${
        canPlay
          ? 'border-white/10 bg-white/[0.04] hover:border-white/16 hover:bg-white/[0.07]'
          : 'border-white/8 bg-white/[0.03] opacity-65'
      }`}
      style={{ contentVisibility: 'auto', containIntrinsicSize: '70px' }}
    >
      <button
        type="button"
        onClick={() => canPlay && play(track, queue)}
        disabled={!canPlay}
        className={`relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl border transition-all ${
          canPlay
            ? 'cursor-pointer border-white/12 bg-white/[0.08] text-white/90 hover:scale-[1.03]'
            : 'cursor-not-allowed border-white/10 bg-white/[0.04] text-white/25'
        }`}
      >
        {artwork ? (
          <>
            <img
              src={artwork}
              alt=""
              className="h-full w-full object-cover"
              decoding="async"
              loading="lazy"
            />
            {canPlay && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all group-hover:bg-black/45 group-hover:opacity-100">
                <Play size={14} fill="white" strokeWidth={0} className="ml-px" />
              </div>
            )}
          </>
        ) : (
          <Music size={16} />
        )}
      </button>

      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-white/92">{track.title}</div>
        <div className="mt-0.5 truncate text-[11px] text-white/40">{track.user.username}</div>
      </div>

      <div className="hidden shrink-0 items-center gap-2 sm:flex">
        {lyricsCached && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClearLyrics(track.urn);
            }}
            title={t('offline.clearLyrics', 'Clear cached lyrics')}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-sky-400/18 bg-sky-400/10 px-2 py-0.5 text-[10px] font-semibold text-sky-100/90 hover:bg-sky-400/20 transition-colors"
          >
            {t('offline.lyrics', 'Lyrics')}
            <span className="text-[10px] opacity-70">×</span>
          </button>
        )}
        
        {cached ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/18 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-100/90">
            <Download size={11} />
            {t('offline.cached')}
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] font-semibold text-white/35">
            {t('offline.notCached')}
          </span>
        )}
      </div>

      <div className="w-12 shrink-0 text-right text-[11px] font-medium tabular-nums text-white/35">
        {dur(track.duration)}
      </div>
    </div>
  );
});

function OfflineSection({
  icon,
  title,
  subtitle,
  items,
  queue,
  cachedUrns,
  cachedLyricsUrns,
  canPlayTrack,
  onClearLyrics,
  emptyText,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  items: Track[];
  queue: Track[];
  cachedUrns: Set<string>;
  cachedLyricsUrns: Set<string>;
  canPlayTrack: (track: Track) => boolean;
  onClearLyrics: (urn: string) => void;
  emptyText: string;
}) {
  return (
    <section className="overflow-hidden rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.06),rgba(255,255,255,0.02))] p-[1px] shadow-[0_18px_60px_rgba(0,0,0,0.28)]">
      <div className="rounded-[27px] bg-black/24 px-4 py-4 backdrop-blur-[28px]">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/12 bg-white/[0.08] text-white/90">
              {icon}
            </div>
            <div>
              <h2 className="text-[17px] font-semibold tracking-tight text-white/92">{title}</h2>
              <p className="mt-0.5 text-[12px] leading-5 text-white/42">{subtitle}</p>
            </div>
          </div>
          <div className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/35">
            {items.length}
          </div>
        </div>

        {items.length > 0 ? (
          <div className="mt-4 max-h-[58vh] space-y-2 overflow-y-auto pr-1">
            {items.map((track) => (
              <OfflineTrackRow
                key={track.urn}
                track={track}
                queue={queue}
                canPlay={canPlayTrack(track)}
                cached={cachedUrns.has(track.urn)}
                lyricsCached={cachedLyricsUrns.has(track.urn)}
                onClearLyrics={onClearLyrics}
              />
            ))}
          </div>
        ) : (
          <div className="mt-4 rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-8 text-center text-[12px] text-white/35">
            {emptyText}
          </div>
        )}
      </div>
    </section>
  );
}

export const OfflinePage = React.memo(() => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const appMode = useAppStatusStore(resolveMode);
  const [state, setState] = useState<OfflineLibraryState>(EMPTY_STATE);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const loadOfflineData = useCallback(async () => {
    const [likedTracks, cachedUrns, lyricsUrns, updatedAt] = await Promise.all([
      getOfflineLikedTracks(),
      listCachedUrns(),
      listCachedLyricsUrns(),
      getOfflineIndexUpdatedAt(),
    ]);

    const cachedSet = new Set(cachedUrns);
    const cachedLyricsSet = new Set(lyricsUrns);
    const cachedTracks = await getOfflineTracksByUrns(cachedUrns);

    setState({
      likedTracks,
      cachedTracks,
      cachedUrns: cachedSet,
      cachedLyricsUrns: cachedLyricsSet,
      updatedAt,
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    const hydrate = async () => {
      try {
        await loadOfflineData();
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void hydrate();

    return () => {
      cancelled = true;
    };
  }, [loadOfflineData]);

  useEffect(() => {
    if (appMode !== 'online') return;

    let cancelled = false;

    const syncLikesInBackground = async () => {
      try {
        await fetchAllLikedTracks();
        if (!cancelled) {
          await loadOfflineData();
        }
      } catch {
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void syncLikesInBackground();

    return () => {
      cancelled = true;
    };
  }, [appMode, loadOfflineData]);

  const handleSyncNow = useCallback(async () => {
    setSyncing(true);
    try {
      invalidateAllLikesCache();
      await fetchAllLikedTracks();
      await loadOfflineData();
    } finally {
      setSyncing(false);
    }
  }, [loadOfflineData]);

  const handleClearLyrics = useCallback(async (urn: string) => {
    await removeLyricsForTrack(urn);
    setState((prev) => {
      const nextLyrics = new Set(prev.cachedLyricsUrns);
      nextLyrics.delete(urn);
      return { ...prev, cachedLyricsUrns: nextLyrics };
    });
  }, []);

  const cachedLikesCount = useMemo(
    () => state.likedTracks.filter((track) => state.cachedUrns.has(track.urn)).length,
    [state.cachedUrns, state.likedTracks],
  );

  const likedPlayableQueue = useMemo(
    () => state.likedTracks.filter((track) => state.cachedUrns.has(track.urn)),
    [state.cachedUrns, state.likedTracks],
  );

  const likesQueue = appMode === 'online' ? state.likedTracks : likedPlayableQueue;
  const cachedQueue = state.cachedTracks;

  const statusConfig = {
    blocked: {
      border: 'border-amber-400/22',
      bg: 'bg-amber-400/10',
      text: 'text-amber-100/90',
      icon: <AlertCircle size={12} />,
      title: t('offline.blockedTitle'),
      description: t('offline.blockedDescription'),
      label: t('offline.blockedBadge'),
    },
    offline: {
      border: 'border-sky-400/22',
      bg: 'bg-sky-400/10',
      text: 'text-sky-100/90',
      icon: <Globe size={12} />,
      title: t('offline.offlineTitle'),
      description: t('offline.offlineDescription'),
      label: t('offline.offlineBadge'),
    },
    online: {
      border: 'border-emerald-400/22',
      bg: 'bg-emerald-400/10',
      text: 'text-emerald-100/90',
      icon: <Download size={12} />,
      title: t('offline.readyTitle'),
      description: t('offline.readyDescription'),
      label: t('offline.readyBadge'),
    },
  }[appMode];

  const lastSyncText = useMemo(() => {
    if (!state.updatedAt) return null;

    const locale = i18n.language === 'ru' ? 'ru-RU' : 'en-US';
    const formatted = new Intl.DateTimeFormat(locale, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(state.updatedAt);

    return t('offline.lastSync', { date: formatted });
  }, [i18n.language, state.updatedAt, t]);

  return (
    <div className="relative min-h-full overflow-hidden px-5 py-6 md:px-7 md:py-7">
      <div
        className="pointer-events-none absolute inset-0"
        style={{ contain: 'strict', transform: 'translateZ(0)' }}
      >
        <div className="absolute left-[-8%] top-[-10%] h-[440px] w-[440px] rounded-full bg-accent/[0.12] blur-[130px]" />
        <div className="absolute bottom-[-12%] right-[-8%] h-[460px] w-[460px] rounded-full bg-sky-400/[0.08] blur-[150px]" />
      </div>

      <div
        className="relative mx-auto flex w-full max-w-[1340px] flex-col gap-5"
        style={{ isolation: 'isolate' }}
      >
        <div className="flex flex-wrap items-center gap-3">
          <div
            className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] ${statusConfig.border} ${statusConfig.bg} ${statusConfig.text}`}
          >
            {statusConfig.icon}
            {statusConfig.label}
          </div>

          <div className="text-[24px] font-semibold tracking-[-0.03em] text-white/94">
            {statusConfig.title}
          </div>

          <div className="h-5 w-px bg-white/10" />

          <div className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[12px] font-medium text-white/50">
            {t('offline.statsLikes')}:{' '}
            <span className="text-white/85">{state.likedTracks.length}</span>
          </div>
          <div className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[12px] font-medium text-white/50">
            {t('offline.statsCached')}:{' '}
            <span className="text-white/85">{state.cachedTracks.length}</span>
          </div>

          {lastSyncText && (
            <div className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[12px] font-medium text-white/45">
              {lastSyncText}
            </div>
          )}

          <button
            type="button"
            onClick={handleSyncNow}
            disabled={syncing || appMode !== 'online'}
            className="ml-auto inline-flex cursor-pointer items-center gap-2 rounded-2xl border border-white/12 bg-white/[0.06] px-3.5 py-2 text-[12px] font-semibold text-white/78 transition-all hover:bg-white/[0.1] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RotateCcw size={14} className={syncing ? 'animate-spin' : ''} />
            {t('offline.syncNow')}
          </button>

          <button
            type="button"
            onClick={() => navigate('/settings')}
            className="inline-flex cursor-pointer items-center gap-2 rounded-2xl border border-white/12 bg-white/[0.04] px-3.5 py-2 text-[12px] font-semibold text-white/70 transition-all hover:bg-white/[0.08]"
          >
            <Settings size={14} />
            {t('offline.openSettings')}
          </button>

          <button
            type="button"
            onClick={() => {
              useAppStatusStore.getState().resetConnectivity();
              navigate('/');
            }}
            className="inline-flex cursor-pointer items-center gap-2 rounded-2xl border border-white/12 bg-white/[0.04] px-3.5 py-2 text-[12px] font-semibold text-white/70 transition-all hover:bg-white/[0.08]"
          >
            <RotateCcw size={14} />
            {t('offline.tryOnline')}
          </button>
        </div>

        <div className="rounded-[24px] border border-white/10 bg-white/[0.03] px-5 py-4 text-[13px] leading-relaxed text-white/45 backdrop-blur-sm">
          {statusConfig.description}
        </div>

        {loading ? (
          <div className="flex items-center justify-center rounded-[28px] border border-white/10 bg-white/[0.03] py-20 text-[13px] font-medium text-white/45">
            {t('common.loading')}
          </div>
        ) : (
          <div className="grid gap-5 xl:grid-cols-2">
            <OfflineSection
              icon={<Heart size={17} />}
              title={t('offline.likesTitle')}
              subtitle={t('offline.likesSubtitle', {
                cached: cachedLikesCount,
                total: state.likedTracks.length,
              })}
              items={state.likedTracks}
              queue={likesQueue}
              cachedUrns={state.cachedUrns}
              cachedLyricsUrns={state.cachedLyricsUrns}
              canPlayTrack={(track) => appMode === 'online' || state.cachedUrns.has(track.urn)}
              onClearLyrics={handleClearLyrics}
              emptyText={t('offline.likesEmpty')}
            />

            <OfflineSection
              icon={<Download size={17} />}
              title={t('offline.cachedTitle')}
              subtitle={t('offline.cachedSubtitle')}
              items={state.cachedTracks}
              queue={cachedQueue}
              cachedUrns={state.cachedUrns}
              cachedLyricsUrns={state.cachedLyricsUrns}
              canPlayTrack={() => true}
              onClearLyrics={handleClearLyrics}
              emptyText={t('offline.cachedEmpty')}
            />
          </div>
        )}
      </div>
    </div>
  );
});
