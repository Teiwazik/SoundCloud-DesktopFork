import React from 'react';
import type { Track } from '../../../stores/player';
import { HorizontalScroll } from '../../ui/HorizontalScroll';
import { Skeleton } from '../../ui/Skeleton';
import { TrackCard } from '../TrackCard';

interface StripProps {
  tracks: Track[];
  /** Card width in px. */
  width?: number;
}

/** Horizontal scroll of TrackCards. */
export const RecommendationsStrip = React.memo(function RecommendationsStrip({
  tracks,
  width = 180,
}: StripProps) {
  return (
    <HorizontalScroll>
      {tracks.map((track) => (
        <div key={track.urn} className="shrink-0" style={{ width }}>
          <TrackCard track={track} queue={tracks} />
        </div>
      ))}
    </HorizontalScroll>
  );
});

interface SkeletonProps {
  count?: number;
  width?: number;
}

/** Placeholder cards while a query is loading. */
export const SkeletonStrip = React.memo(function SkeletonStrip({
  count = 8,
  width = 180,
}: SkeletonProps) {
  return (
    <HorizontalScroll>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="shrink-0" style={{ width }}>
          <Skeleton className="aspect-square w-full" rounded="lg" />
          <Skeleton className="h-4 w-3/4 mt-2.5" rounded="sm" />
          <Skeleton className="h-3 w-1/2 mt-1.5" rounded="sm" />
        </div>
      ))}
    </HorizontalScroll>
  );
});
