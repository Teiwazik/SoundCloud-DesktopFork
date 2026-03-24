import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { LikeButton } from '../components/music/LikeButton';
import { MixCard } from '../components/music/MixCard';
import { SoundWaveHero } from '../components/music/SoundWaveHero';
import { TrackCard } from '../components/music/TrackCard';
import { HorizontalScroll } from '../components/ui/HorizontalScroll';
import { Skeleton } from '../components/ui/Skeleton';
import { preloadTrack } from '../lib/audio';
import { ago, art, dur, fc } from '../lib/formatters';
import type { FeedItem } from '../lib/hooks';
import {
  useDiscoverData,
  useFallbackTracks,
  useFeed,
  useFollowingTracks,
  useInfiniteScroll,
  useLikedTracks,
  useRecommendedTracks,
  useRelatedPool,
} from '../lib/hooks';
import {
  ChevronRight,
  Compass,
  Headphones,
  Heart,
  headphones9,
  heart9,
  ListMusic,
  Loader2,
  listMusic8,
  listMusic9,
  Music,
  musicIcon22,
  pauseBlack14,
  playBlack14,
  Repeat2,
  Sparkles,
} from '../lib/icons';
import { useTrackPlay } from '../lib/useTrackPlay';
import { useAuthStore } from '../stores/auth';
import type { Track } from '../stores/player';
import { usePlayerStore } from '../stores/player';

/* ── Helpers ──────────────────────────────────────────────── */

function LazyRender({
  children,
  minHeight = 100,
}: {
  children: React.ReactNode;
  minHeight?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setIsVisible(entry.isIntersecting), {
      root: el.closest('main'),
      rootMargin: '1200px 0px',
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      style={{ minHeight: isVisible ? undefined : minHeight, contentVisibility: 'auto' }}
    >
      {isVisible ? children : null}
    </div>
  );
}

function greetingKey() {
  const h = new Date().getHours();
  if (h < 6) return 'home.goodNight';
  if (h < 12) return 'home.goodMorning';
  if (h < 18) return 'home.goodAfternoon';
  return 'home.goodEvening';
}

/* ── Section Header ───────────────────────────────────────── */

function SectionHeader({
  title,
  icon,
  onSeeAll,
}: {
  title: string;
  icon: React.ReactNode;
  onSeeAll?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between mb-5">
      <div className="flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-xl bg-white/[0.04] border border-white/[0.06] flex items-center justify-center">
          {icon}
        </div>
        <h2 className="text-[15px] font-semibold tracking-tight text-white/90">{title}</h2>
      </div>
      {onSeeAll && (
        <button
          type="button"
          onClick={onSeeAll}
          className="flex items-center gap-1 text-[11px] text-white/30 hover:text-white/60 transition-colors duration-200 cursor-pointer"
        >
          {t('common.seeAll')}
          <ChevronRight size={12} />
        </button>
      )}
    </div>
  );
}

/* ── Skeletons ────────────────────────────────────────────── */

function ShelfSkeleton({ count = 8 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="w-[180px] shrink-0">
          <Skeleton className="aspect-square w-full" rounded="lg" />
          <Skeleton className="h-4 w-3/4 mt-2.5" rounded="sm" />
          <Skeleton className="h-3 w-1/2 mt-1.5" rounded="sm" />
        </div>
      ))}
    </>
  );
}

function FeedSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[repeat(auto-fill,minmax(380px,1fr))] gap-2.5">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="glass-flat rounded-2xl p-3 flex items-center gap-3.5">
          <Skeleton className="w-[76px] h-[76px] shrink-0" rounded="lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-3/4" rounded="sm" />
            <Skeleton className="h-3 w-1/2" rounded="sm" />
            <Skeleton className="h-2.5 w-2/5" rounded="sm" />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Feed Track Card (compact horizontal) ─────────────────── */

const FeedTrackCard = React.memo(
  function FeedTrackCard({ item, queue }: { item: FeedItem; queue: Track[] }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const track = item.origin as Track;
    const { isThis, isThisPlaying, togglePlay } = useTrackPlay(track, queue);
    const isRepost = item.type.includes('repost');
    const cover = art(track.artwork_url, 't300x300');

    return (
      <div
        className={`group glass-flat rounded-2xl p-3 flex items-center gap-3.5 transition-all duration-300 ease-[var(--ease-apple)] ${
          isThis ? 'ring-1 ring-accent/20 bg-accent/[0.02]' : 'hover:bg-white/[0.035]'
        }`}
        onMouseEnter={() => preloadTrack(track.urn)}
      >
        {/* Artwork */}
        <div
          className="relative w-[76px] h-[76px] rounded-xl overflow-hidden shrink-0 ring-1 ring-white/[0.06] cursor-pointer"
          onClick={togglePlay}
        >
          {cover ? (
            <img src={cover} alt={track.title} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-white/[0.04] to-white/[0.01]">
              {musicIcon22}
            </div>
          )}

          {/* Play overlay */}
          <div
            className={`absolute inset-0 flex items-center justify-center transition-all duration-200 ${
              isThisPlaying
                ? 'bg-black/30 opacity-100'
                : 'bg-black/0 opacity-0 group-hover:bg-black/30 group-hover:opacity-100'
            }`}
          >
            <div
              className={`w-9 h-9 rounded-full flex items-center justify-center shadow-lg transition-all duration-200 ease-[var(--ease-apple)] ${
                isThisPlaying ? 'bg-white scale-100' : 'bg-white/90 scale-75 group-hover:scale-100'
              }`}
            >
              {isThisPlaying ? pauseBlack14 : playBlack14}
            </div>
          </div>
        </div>

        {/* Track info */}
        <div className="flex-1 min-w-0">
          {isRepost && (
            <div className="flex items-center gap-1 mb-1 text-[10px] text-white/20 font-medium">
              <Repeat2 size={9} />
              <span>{t('home.reposted')}</span>
            </div>
          )}
          <p
            className="text-[13px] font-medium text-white/90 truncate leading-snug cursor-pointer hover:text-white transition-colors duration-150"
            onClick={() => navigate(`/track/${encodeURIComponent(track.urn)}`)}
          >
            {track.title}
          </p>
          <p
            className="text-[11px] text-white/35 truncate mt-0.5 cursor-pointer hover:text-white/55 transition-colors duration-150"
            onClick={() => navigate(`/user/${encodeURIComponent(track.user.urn)}`)}
          >
            {track.user.username}
          </p>
          <div className="flex items-center gap-2 mt-1.5 text-[10px] text-white/20 tabular-nums">
            {track.genre && (
              <span className="px-1.5 py-px rounded-full bg-white/[0.04] text-white/30 border border-white/[0.04] text-[9px]">
                {track.genre}
              </span>
            )}
            <span className="flex items-center gap-0.5">
              {headphones9}
              {fc(track.playback_count)}
            </span>
            <span className="flex items-center gap-0.5">
              {heart9}
              {fc(track.favoritings_count ?? track.likes_count)}
            </span>
          </div>
        </div>

        {/* Like */}
        <LikeButton track={track} />

        {/* Duration + time */}
        <div className="text-right shrink-0 self-center">
          <p className="text-[11px] text-white/30 tabular-nums font-medium">
            {dur(track.duration)}
          </p>
          <p className="text-[10px] text-white/15 mt-0.5">{ago(item.created_at)}</p>
        </div>
      </div>
    );
  },
  (prev, next) => prev.item.origin.urn === next.item.origin.urn,
);

/* ── Feed Playlist Card ───────────────────────────────────── */

const FeedPlaylistCard = React.memo(
  function FeedPlaylistCard({ item }: { item: FeedItem }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [loading, setLoading] = useState(false);
    const origin = item.origin;
    const isRepost = item.type.includes('repost');
    const cover =
      art(origin.artwork_url, 't300x300') ?? art(origin.tracks?.[0]?.artwork_url, 't300x300');

    // Only re-render when this playlist's playing state actually changes
    const trackUrns = useMemo(
      () => new Set((origin.tracks ?? []).map((t: Track) => t.urn)),
      [origin.tracks],
    );
    const isPlayingFromThis = usePlayerStore(
      (s) => s.isPlaying && s.currentTrack != null && trackUrns.has(s.currentTrack.urn),
    );
    const isPausedFromThis = usePlayerStore(
      (s) => !s.isPlaying && s.currentTrack != null && trackUrns.has(s.currentTrack.urn),
    );

    const handlePlay = async (e: React.MouseEvent) => {
      e.stopPropagation();
      const { play, pause, resume } = usePlayerStore.getState();
      if (isPlayingFromThis) {
        pause();
        return;
      }
      if (isPausedFromThis) {
        resume();
        return;
      }

      if (origin.tracks && origin.tracks.length > 0) {
        play(origin.tracks[0], origin.tracks);
        return;
      }

      setLoading(true);
      try {
        const data = await import('../lib/api').then((m) =>
          m.api<{ collection: Track[] }>(`/playlists/${encodeURIComponent(origin.urn)}/tracks`),
        );
        const tracks = data.collection;
        if (tracks.length > 0) {
          play(tracks[0], tracks);
        }
      } catch {
        navigate(`/playlist/${encodeURIComponent(origin.urn)}`);
      } finally {
        setLoading(false);
      }
    };

    return (
      <div
        className={`group glass-flat rounded-2xl p-3 flex items-center gap-3.5 transition-all duration-300 ease-[var(--ease-apple)] ${
          isPlayingFromThis ? 'ring-1 ring-accent/20 bg-accent/[0.02]' : 'hover:bg-white/[0.035]'
        }`}
      >
        {/* Artwork */}
        <div
          className="relative w-[76px] h-[76px] rounded-xl overflow-hidden shrink-0 ring-1 ring-white/[0.06] cursor-pointer"
          onClick={handlePlay}
        >
          {cover ? (
            <img src={cover} alt={origin.title} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-white/[0.04] to-white/[0.01]">
              <ListMusic size={22} className="text-white/15" />
            </div>
          )}

          {/* Play overlay */}
          <div
            className={`absolute inset-0 flex items-center justify-center transition-all duration-200 ${
              isPlayingFromThis
                ? 'bg-black/30 opacity-100'
                : 'bg-black/0 opacity-0 group-hover:bg-black/30 group-hover:opacity-100'
            }`}
          >
            {loading ? (
              <Loader2 size={16} className="text-white animate-spin" />
            ) : (
              <div
                className={`w-9 h-9 rounded-full flex items-center justify-center shadow-lg transition-all duration-200 ease-[var(--ease-apple)] ${
                  isPlayingFromThis
                    ? 'bg-white scale-100'
                    : 'bg-white/90 scale-75 group-hover:scale-100'
                }`}
              >
                {isPlayingFromThis ? pauseBlack14 : playBlack14}
              </div>
            )}
          </div>

          {/* Track count pill */}
          {origin.track_count != null && (
            <div className="absolute bottom-1.5 right-1.5 flex items-center gap-0.5 text-[9px] font-medium bg-black/50 backdrop-blur-md text-white/70 px-1.5 py-0.5 rounded-full">
              {listMusic8}
              {origin.track_count}
            </div>
          )}
        </div>

        {/* Playlist info */}
        <div className="flex-1 min-w-0">
          {isRepost && (
            <div className="flex items-center gap-1 mb-1 text-[10px] text-white/20 font-medium">
              <Repeat2 size={9} />
              <span>{t('home.reposted')}</span>
            </div>
          )}
          <p
            className="text-[13px] font-medium text-white/90 truncate leading-snug cursor-pointer hover:text-white transition-colors duration-150"
            onClick={() => navigate(`/playlist/${encodeURIComponent(origin.urn)}`)}
          >
            {origin.title}
          </p>
          <p
            className="text-[11px] text-white/35 truncate mt-0.5 cursor-pointer hover:text-white/55 transition-colors duration-150"
            onClick={() =>
              origin.user?.urn && navigate(`/user/${encodeURIComponent(origin.user.urn)}`)
            }
          >
            {origin.user?.username}
          </p>
          <div className="flex items-center gap-2 mt-1.5 text-[10px] text-white/20">
            <span className="flex items-center gap-0.5">
              {listMusic9}
              {origin.track_count ?? 0} {t('search.tracks').toLowerCase()}
            </span>
          </div>
        </div>

        {/* Time */}
        <div className="text-right shrink-0 self-center">
          <p className="text-[10px] text-white/15">{ago(item.created_at)}</p>
        </div>
      </div>
    );
  },
  (prev, next) => prev.item.origin.urn === next.item.origin.urn,
);

/* ── Isolated Sections ────────────────────────────────────── */

const FallbackShelf = React.memo(function FallbackShelf() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);

  // If user has any likes or followings, they're not a new user — no fallback needed
  const hasActivity = (user?.public_favorites_count ?? 0) > 0 || (user?.followings_count ?? 0) > 0;

  const { data: fallbackData, isLoading: fallbackLoading } = useFallbackTracks();
  const fallbackTracks = useMemo(() => fallbackData?.collection ?? [], [fallbackData]);

  if (hasActivity || (!fallbackLoading && fallbackTracks.length === 0)) return null;

  return (
    <section>
      <SectionHeader
        title={t('home.startListening', 'Start Listening')}
        icon={<Headphones size={15} className="text-accent" />}
      />
      <HorizontalScroll>
        {fallbackLoading ? (
          <ShelfSkeleton count={3} />
        ) : (
          fallbackTracks.map((track) => (
            <div key={track.urn} className="w-[180px] shrink-0">
              <TrackCard track={track} queue={fallbackTracks} />
            </div>
          ))
        )}
      </HorizontalScroll>
    </section>
  );
});

const LikedShelf = React.memo(function LikedShelf({
  likedTracks,
  isLoading,
}: {
  likedTracks: Track[];
  isLoading: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const displayTracks = useMemo(() => likedTracks.slice(0, 50), [likedTracks]);

  if (!isLoading && displayTracks.length === 0) return null;

  return (
    <section>
      <SectionHeader
        title={t('library.likedTracks')}
        icon={<Heart size={15} className="text-accent" />}
        onSeeAll={() => navigate('/library')}
      />
      <HorizontalScroll>
        {isLoading ? (
          <ShelfSkeleton />
        ) : (
          displayTracks.map((track) => (
            <div key={track.urn} className="w-[180px] shrink-0">
              <TrackCard track={track} queue={displayTracks} />
            </div>
          ))
        )}
      </HorizontalScroll>
    </section>
  );
});

const FollowingShelf = React.memo(function FollowingShelf() {
  const { t } = useTranslation();
  const { data: following, isLoading } = useFollowingTracks(20);
  const followingTracks = useMemo(() => following?.collection ?? [], [following]);

  if (!isLoading && followingTracks.length === 0) return null;

  return (
    <section>
      <SectionHeader
        title={t('home.freshReleases')}
        icon={<Music size={15} className="text-white/50" />}
      />
      <HorizontalScroll>
        {isLoading ? (
          <ShelfSkeleton />
        ) : (
          followingTracks.map((track) => (
            <div key={track.urn} className="w-[180px] shrink-0">
              <TrackCard track={track} queue={followingTracks} />
            </div>
          ))
        )}
      </HorizontalScroll>
    </section>
  );
});

const MixShelf = React.memo(function MixShelf({
  pool,
  isLoading,
}: {
  pool: ReturnType<typeof useRelatedPool>['data'];
  isLoading: boolean;
}) {
  const recommendedTracks = useRecommendedTracks(pool, 6); // Just top 6 for mixes

  const mixColors = ['#ff5500', '#00ffcc', '#ff00ff', '#f0f000', '#0099ff', '#ff3300'];

  if (!isLoading && recommendedTracks.length === 0) return null;

  return (
    <section>
      <SectionHeader
        title="Миксы для тебя"
        icon={<Headphones size={15} className="text-accent" />}
      />
      <HorizontalScroll>
        {isLoading ? (
          <ShelfSkeleton count={6} />
        ) : (
          recommendedTracks.map((track, i) => (
            <MixCard
              key={track.urn}
              index={i}
              title={track.title}
              subtitle={track.user.username}
              artworkUrl={art(track.artwork_url, 't500x500') ?? undefined}
              color={mixColors[i % mixColors.length]}
              onClick={() => {
                const { play } = usePlayerStore.getState();
                play(track, recommendedTracks);
              }}
            />
          ))
        )}
      </HorizontalScroll>
    </section>
  );
});

const DiscoverSection = React.memo(function DiscoverSection({
  likedTracks,
  pool,
  isLoading,
}: {
  likedTracks: Track[];
  pool: ReturnType<typeof useRelatedPool>['data'];
  isLoading: boolean;
}) {
  const { t } = useTranslation();

  // ── Recommended ──
  const recommendedTracks = useRecommendedTracks(pool, 40);

  // ── Discover by genre ──
  const discoverData = useDiscoverData(pool, likedTracks);
  const [activeGenre, setActiveGenre] = useState<string | null>(null);
  const genres = useMemo(() => discoverData.map((d) => d.genre), [discoverData]);
  const selectedGenre =
    (typeof activeGenre === 'string' && genres.includes(activeGenre) ? activeGenre : genres[0]) ??
    undefined;
  const genreTracks = useMemo(
    () => discoverData.find((d) => d.genre === selectedGenre)?.tracks ?? [],
    [discoverData, selectedGenre],
  );

  return (
    <>
      {/* Recommended For You */}
      {(isLoading || recommendedTracks.length > 0) && (
        <section>
          <SectionHeader
            title={t('home.recommended', 'Recommended For You')}
            icon={<Sparkles size={15} className="text-amber-400/70" />}
          />
          <HorizontalScroll>
            {isLoading ? (
              <ShelfSkeleton />
            ) : (
              recommendedTracks.map((track) => (
                <div key={track.urn} className="w-[180px] shrink-0">
                  <TrackCard track={track} queue={recommendedTracks} />
                </div>
              ))
            )}
          </HorizontalScroll>
        </section>
      )}

      {/* Discover by genre */}
      {(isLoading || genres.length > 0) && (
        <section>
          <SectionHeader
            title={t('home.discover', 'Discover')}
            icon={<Compass size={15} className="text-cyan-400/70" />}
          />
          <div className="flex items-center gap-1.5 mb-4 flex-wrap">
            {genres.map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setActiveGenre(g)}
                className={`px-3.5 py-1.5 rounded-full text-[12px] font-medium transition-all duration-200 cursor-pointer capitalize ${
                  selectedGenre === g
                    ? 'bg-white/[0.12] text-white border border-white/[0.08]'
                    : 'bg-white/[0.03] text-white/40 border border-white/[0.04] hover:bg-white/[0.06] hover:text-white/60'
                }`}
              >
                {g}
              </button>
            ))}
          </div>
          <HorizontalScroll>
            {isLoading ? (
              <ShelfSkeleton />
            ) : (
              genreTracks.map((track) => (
                <div key={track.urn} className="w-[180px] shrink-0">
                  <TrackCard track={track} queue={genreTracks} />
                </div>
              ))
            )}
          </HorizontalScroll>
        </section>
      )}
    </>
  );
});

const FeedStream = React.memo(function FeedStream() {
  const { t } = useTranslation();
  const { items: feedItems, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = useFeed();

  const sentinelRef = useInfiniteScroll(hasNextPage, isFetchingNextPage, fetchNextPage);

  const featuredItem = useMemo(() => feedItems.find((i) => i.type.includes('track')), [feedItems]);
  const streamItems = useMemo(
    () => feedItems.filter((i) => i !== featuredItem),
    [feedItems, featuredItem],
  );
  const feedTrackQueue = useMemo(
    () => feedItems.filter((i) => i.type.includes('track')).map((i) => i.origin as Track),
    [feedItems],
  );

  return (
    <section>
      <SectionHeader
        title={t('home.yourFeed')}
        icon={<Music size={15} className="text-white/50" />}
      />

      {isLoading ? (
        <FeedSkeleton />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-[repeat(auto-fill,minmax(380px,1fr))] gap-2.5">
          {streamItems.map((item) => (
            <LazyRender key={item.origin.urn} minHeight={100}>
              {item.type.includes('track') ? (
                <FeedTrackCard item={item} queue={feedTrackQueue} />
              ) : (
                <FeedPlaylistCard item={item} />
              )}
            </LazyRender>
          ))}
        </div>
      )}

      {/* Sentinel for infinite scroll */}
      <div ref={sentinelRef} className="h-12 flex items-center justify-center">
        {isFetchingNextPage && <Loader2 size={18} className="text-white/15 animate-spin" />}
        {!isLoading && !hasNextPage && !isFetchingNextPage && streamItems.length > 0 && (
          <div className="flex items-center gap-2 text-[11px] text-white/15">
            <div className="h-px w-8 bg-white/[0.06]" />
            <span>{t('home.endOfFeed')}</span>
            <div className="h-px w-8 bg-white/[0.06]" />
          </div>
        )}
      </div>
    </section>
  );
});

/* ── Home Page ────────────────────────────────────────────── */

export function Home() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);

  const { tracks: likedTracks, isLoading: isLikesLoading } = useLikedTracks(100);
  const { data: pool, isLoading: isPoolLoading } = useRelatedPool(likedTracks);

  return (
    <div className="p-6 pb-6 space-y-12">
      {/* Hero Greeting */}
      <section className="pt-2">
        <h1 className="text-4xl font-bold tracking-tight greeting-gradient leading-[1.15] animate-fade-in-up">
          {t(greetingKey())}
          {user?.username ? `, ${user.username}` : ''}
        </h1>
        <div className="mt-5 h-px bg-gradient-to-r from-white/[0.08] via-white/[0.04] to-transparent w-full" />
      </section>

      <SoundWaveHero />
      <MixShelf pool={pool} isLoading={isPoolLoading} />
      <FallbackShelf />
      <LikedShelf likedTracks={likedTracks} isLoading={isLikesLoading} />
      <FollowingShelf />
      <DiscoverSection likedTracks={likedTracks} pool={pool} isLoading={isPoolLoading} />
      <FeedStream />
    </div>
  );
}
