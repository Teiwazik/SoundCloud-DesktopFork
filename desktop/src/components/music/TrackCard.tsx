import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { preloadTrack } from '../../lib/audio';
import { art, dur, fc } from '../../lib/formatters';
import { ListPlus, pauseBlack20, playBlack20, playIcon32 } from '../../lib/icons';
import { useTilt } from '../../lib/hooks/useTilt';
import { useTrackPlay } from '../../lib/useTrackPlay';
import type { Track } from '../../stores/player';
import { AddToPlaylistDialog } from './AddToPlaylistDialog';
import { LikeButton } from './LikeButton';

interface TrackCardProps {
  track: Track;
  queue?: Track[];
  variant?: 'default' | 'shelf';
}

export const TrackCard = React.memo(
  function TrackCard({ track, queue, variant = 'default' }: TrackCardProps) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { isThisPlaying, togglePlay } = useTrackPlay(track, queue);
    const artwork = art(track.artwork_url, 't300x300');
    const isShelf = variant === 'shelf';

    const { ref, onMouseEnter, onMouseMove, onMouseLeave } = useTilt();

    return (
      <div
        ref={isShelf ? undefined : ref}
        className="group relative"
        onMouseEnter={() => {
          if (!isShelf) onMouseEnter();
          preloadTrack(track.urn);
        }}
        onMouseMove={isShelf ? undefined : onMouseMove}
        onMouseLeave={isShelf ? undefined : onMouseLeave}
      >
        <div
          className={`relative aspect-square rounded-2xl overflow-hidden bg-white/[0.03] cursor-pointer ring-1 ring-white/[0.06] ${
            isShelf
              ? 'transition-colors duration-200 group-hover:bg-white/[0.045]'
              : 'group-hover:ring-white/[0.12] transition-all duration-300 ease-[var(--ease-apple)]'
          }`}
          onClick={togglePlay}
        >
          {artwork ? (
            <img
              src={artwork}
              alt={track.title}
              className={`w-full h-full object-cover ${
                isShelf
                  ? 'transition-opacity duration-200'
                  : 'transition-transform duration-500 ease-[var(--ease-apple)] group-hover:scale-[1.04]'
              }`}
              decoding="async"
              loading="lazy"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-white/20">
              {playIcon32}
            </div>
          )}

          <div
            className={`absolute inset-0 flex items-center justify-center transition-all duration-300 ${
              isThisPlaying
                ? 'bg-black/30 backdrop-blur-[2px] opacity-100'
                : isShelf
                  ? 'bg-black/0 opacity-0 group-hover:bg-black/25 group-hover:opacity-100'
                  : 'bg-black/0 opacity-0 group-hover:bg-black/30 group-hover:backdrop-blur-[2px] group-hover:opacity-100'
            }`}
          >
            <div
              className={`w-12 h-12 rounded-full flex items-center justify-center transition-all duration-300 ease-[var(--ease-apple)] shadow-xl ${
                isThisPlaying
                  ? 'bg-white scale-100'
                  : isShelf
                    ? 'bg-white/90 scale-90 group-hover:scale-100'
                    : 'bg-white/90 scale-75 group-hover:scale-100'
              }`}
            >
              {isThisPlaying ? pauseBlack20 : playBlack20}
            </div>
          </div>

          <div
            className={`absolute bottom-2 right-2 flex items-center gap-1 transition-opacity duration-200 ${
              isShelf ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            }`}
          >
            {track.access === 'preview' && (
              <div
                className={`text-[10px] font-medium text-white px-2 py-0.5 rounded-full ${
                  isShelf ? 'bg-amber-500/75' : 'bg-amber-500/80 backdrop-blur-md'
                }`}
              >
                {t('track.preview')}
              </div>
            )}
            <div
              className={`text-[10px] font-medium text-white/80 px-2 py-0.5 rounded-full ${
                isShelf ? 'bg-black/45' : 'bg-black/50 backdrop-blur-md'
              }`}
            >
              {dur(track.duration)}
            </div>
          </div>

          <LikeButton track={track} variant="overlay" />

          {!isShelf && (
            <div className="absolute top-2 right-2 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
              <AddToPlaylistDialog trackUrn={track.urn}>
                <button
                  type="button"
                  onClick={(e) => e.stopPropagation()}
                  className="cursor-pointer w-8 h-8 rounded-full bg-black/50 backdrop-blur-md flex items-center justify-center text-white/80 hover:text-white hover:bg-black/70 transition-all duration-200"
                  title={t('playlist.addToPlaylist')}
                >
                  <ListPlus size={14} />
                </button>
              </AddToPlaylistDialog>
            </div>
          )}
        </div>

        <div className="mt-3 min-w-0">
          <p
            className="text-[13px] font-medium text-white/90 truncate leading-snug cursor-pointer hover:text-white transition-colors duration-150"
            onClick={() => navigate(`/track/${encodeURIComponent(track.urn)}`)}
          >
            {track.title}
          </p>
          {track.user && (
            <p
              className="text-[11px] text-white/35 truncate mt-0.5 cursor-pointer hover:text-white/55 transition-colors duration-150"
              onClick={() => navigate(`/user/${encodeURIComponent(track.user!.urn)}`)}
            >
              {track.user.username}
            </p>
          )}
          {track.playback_count != null && (
            <p className="text-[10px] text-white/20 mt-1 tabular-nums">
              {fc(track.playback_count)} plays
            </p>
          )}
        </div>
      </div>
    );
  },
  (prev, next) =>
    prev.track.urn === next.track.urn &&
    Boolean(prev.track.user_favorite) === Boolean(next.track.user_favorite) &&
    prev.queue === next.queue &&
    prev.variant === next.variant,
);
