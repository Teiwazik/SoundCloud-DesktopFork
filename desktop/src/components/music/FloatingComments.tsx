import React, { useEffect, useRef } from 'react';
import { getCurrentTime, subscribe } from '../../lib/audio';
import { art } from '../../lib/formatters';
import type { Comment } from '../../lib/hooks';
import { useTrackComments } from '../../lib/hooks';
import { usePlayerStore } from '../../stores/player';
import { useSettingsStore } from '../../stores/settings';

interface Pill {
  id: number;
  comment: Comment;
  addedAt: number;
}

function getMaxVisible(): number {
  const h = window.innerHeight;
  if (h < 540) return 1;
  if (h < 720) return 2;
  if (h < 960) return 3;
  return 4;
}

export const FloatingComments = React.memo(function FloatingComments({
  side = 'center',
}: {
  side?: 'center' | 'right';
}) {
  const enabled = useSettingsStore((s) => s.floatingComments);
  const trackUrn = usePlayerStore((s) => s.currentTrack?.urn);

  if (!enabled || !trackUrn) return null;
  return <FloatingCommentsInner trackUrn={trackUrn} side={side} />;
});

const FloatingCommentsInner = React.memo(function FloatingCommentsInner({
  trackUrn,
  side,
}: {
  trackUrn: string;
  side: 'center' | 'right';
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pillsRef = useRef<Pill[]>([]);
  const shownIds = useRef(new Set<number>());
  const nextPillId = useRef(0);

  const { comments } = useTrackComments(trackUrn);

  // Filter comments with timestamp and body
  const timedComments = useRef<Comment[]>([]);
  useEffect(() => {
    timedComments.current = comments.filter((c) => c.timestamp != null && c.body);
    shownIds.current.clear();
  }, [comments]);

  useEffect(() => {
    let lastCheck = 0;

    const unsub = subscribe(() => {
      const now = Date.now();
      if (now - lastCheck < 500) return; // throttle 500ms
      lastCheck = now;

      const currentMs = getCurrentTime() * 1000;
      const container = containerRef.current;
      if (!container) return;

      const maxVisible = getMaxVisible();

      // Check for new comments to show
      for (const c of timedComments.current) {
        if (shownIds.current.has(c.id)) continue;
        if (c.timestamp == null) continue;
        if (Math.abs(c.timestamp - currentMs) < 2000) {
          if (pillsRef.current.length >= maxVisible) break;
          shownIds.current.add(c.id);
          const pill: Pill = { id: nextPillId.current++, comment: c, addedAt: now };
          pillsRef.current.push(pill);
          renderPill(container, pill);
        }
      }

      // Remove expired pills (>5.5s)
      const expired = pillsRef.current.filter((p) => now - p.addedAt > 5500);
      for (const p of expired) {
        const el = container.querySelector(`[data-pill-id="${p.id}"]`) as HTMLElement | null;
        if (el) {
          el.style.opacity = '0';
          el.style.transform = 'translateY(8px)';
          setTimeout(() => el.remove(), 300);
        }
      }
      pillsRef.current = pillsRef.current.filter((p) => now - p.addedAt <= 5800);
    });

    return unsub;
  }, []);

  return (
    <div
      ref={containerRef}
      className={`absolute bottom-4 z-50 flex flex-col-reverse gap-2 pointer-events-none ${
        side === 'right'
          ? 'right-6 items-end'
          : 'left-1/2 -translate-x-1/2 items-center'
      }`}
    />
  );
});

function renderPill(container: HTMLDivElement, pill: Pill) {
  const { comment } = pill;
  const el = document.createElement('div');
  el.setAttribute('data-pill-id', String(pill.id));
  el.className =
    'flex items-center gap-2.5 px-4 py-2 rounded-full backdrop-blur-xl border border-white/10 pointer-events-auto transition-all duration-300 ease-out';
  el.style.cssText = 'background: rgba(255,255,255,0.08); transform: scale(0.5); opacity: 0;';

  const avatar = document.createElement('img');
  avatar.src = art(comment.user.avatar_url, 'small') || '';
  avatar.className = 'w-7 h-7 rounded-full object-cover shrink-0';
  avatar.alt = '';

  const body = document.createElement('span');
  body.className = 'text-[13px] text-white/80 max-w-[300px] truncate';
  body.textContent = comment.body;

  el.appendChild(avatar);
  el.appendChild(body);

  if (comment.timestamp != null) {
    const ts = document.createElement('span');
    const sec = Math.floor(comment.timestamp / 1000);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    ts.className = 'text-[11px] text-white/30 tabular-nums shrink-0';
    ts.textContent = `${m}:${String(s).padStart(2, '0')}`;
    el.appendChild(ts);
  }

  container.prepend(el);

  // Trigger enter animation
  requestAnimationFrame(() => {
    el.style.transform = 'scale(1)';
    el.style.opacity = '1';
  });
}
