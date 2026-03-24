import React, { useEffect, useRef } from 'react';
import { getCurrentTime, subscribe } from '../../lib/audio';
import { art } from '../../lib/formatters';
import { api } from '../../lib/api';
import { usePlayerStore } from '../../stores/player';
import { useSettingsStore } from '../../stores/settings';
import { useQuery } from '@tanstack/react-query';

interface Comment {
  id: number;
  body: string;
  timestamp: number | null;
  user: {
    username: string;
    avatar_url: string;
  };
}

interface Pill {
  id: number;
  comment: Comment;
  addedAt: number;
}

export type FloatingCommentsMode = 'default' | 'sidebar';

function getMaxVisible(mode: FloatingCommentsMode): number {
  if (mode === 'sidebar') {
    const h = window.innerHeight;
    if (h < 540) return 4;
    if (h < 720) return 8;
    if (h < 960) return 12;
    return 14;
  }
  const h = window.innerHeight;
  if (h < 540) return 1;
  if (h < 720) return 2;
  if (h < 960) return 3;
  return 4;
}

export const FloatingComments: React.FC<{ mode?: FloatingCommentsMode }> = ({ mode = 'default' }) => {
  const enabled = useSettingsStore((s) => s.floatingComments);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const trackUrn = currentTrack?.urn;

  const { data: comments } = useQuery({
    queryKey: ['comments', trackUrn],
    queryFn: async () => {
      const res = await api<{ collection: Comment[] }>(`/tracks/${encodeURIComponent(trackUrn!)}/comments?limit=200`);
      return res.collection || [];
    },
    enabled: !!trackUrn && enabled,
    staleTime: 60 * 60 * 1000,
  });

  if (!enabled || !trackUrn || !comments) return null;
  return <FloatingCommentsInner comments={comments} mode={mode} />;
};

const FloatingCommentsInner: React.FC<{ comments: Comment[]; mode: FloatingCommentsMode }> = ({ comments, mode }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const pillsRef = useRef<Pill[]>([]);
  const shownIds = useRef(new Set<number>());
  const nextPillId = useRef(0);

  useEffect(() => {
    shownIds.current.clear();
    if (containerRef.current) containerRef.current.innerHTML = '';
    pillsRef.current = [];
  }, [comments]);

  useEffect(() => {
    let lastCheck = 0;

    const unsub = subscribe(() => {
      const now = Date.now();
      if (now - lastCheck < 500) return;
      lastCheck = now;

      const currentMs = getCurrentTime() * 1000;
      const container = containerRef.current;
      if (!container) return;

      const maxVisible = getMaxVisible(mode);

      for (const c of comments) {
        if (shownIds.current.has(c.id)) continue;
        if (c.timestamp == null) continue;
        
        if (Math.abs(c.timestamp - currentMs) < 1500) {
          if (pillsRef.current.length >= maxVisible) {
             const oldest = pillsRef.current.shift();
             if (oldest) removePill(container, oldest.id, mode);
          }
          
          shownIds.current.add(c.id);
          const pill: Pill = { id: nextPillId.current++, comment: c, addedAt: now };
          pillsRef.current.push(pill);
          renderPill(container, pill, mode);
        }
      }

      // Auto-remove expired pills
      const ttl = mode === 'sidebar' ? 12000 : 5500;
      const expired = pillsRef.current.filter((p) => now - p.addedAt > ttl);
      for (const p of expired) {
        removePill(container, p.id, mode);
      }
      pillsRef.current = pillsRef.current.filter((p) => now - p.addedAt <= ttl + 300);
    });

    return unsub;
  }, [comments, mode]);

  const containerClass = mode === 'sidebar'
    ? 'fixed top-[80px] right-[40px] bottom-[120px] w-[340px] z-[160] pointer-events-none flex flex-col justify-end gap-[8px] overflow-hidden'
    : 'fixed bottom-[100px] left-1/2 -translate-x-1/2 z-[160] pointer-events-none flex flex-col items-center gap-[10px]';

  return (
    <div
      id="comments-overlay"
      ref={containerRef}
      className={containerClass}
      style={mode === 'sidebar' ? {
        maskImage: 'linear-gradient(to bottom, transparent 0%, black 15%)',
        WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 15%)',
      } : undefined}
    />
  );
};

function renderPill(container: HTMLDivElement, pill: Pill, mode: FloatingCommentsMode) {
  const { comment } = pill;
  const el = document.createElement('div');
  el.setAttribute('data-pill-id', String(pill.id));

  if (mode === 'sidebar') {
    // Sidebar mode: slide in from right, full width card
    el.className = 'timed-comment flex flex-shrink-0 items-start gap-3 bg-white/[0.06] backdrop-blur-xl border border-white/[0.06] rounded-2xl pointer-events-auto transition-all duration-[400ms] cubic-bezier(0.16, 1, 0.3, 1) overflow-hidden';
    el.style.opacity = '0';
    el.style.transform = 'translateX(60px)';
    el.style.padding = '10px 14px';
    el.style.marginBottom = '0';

    const avatar = document.createElement('img');
    avatar.src = art(comment.user.avatar_url, 'small') || '';
    avatar.className = 'w-[24px] h-[24px] rounded-full object-cover shrink-0 mt-0.5';
    avatar.alt = '';

    const textCol = document.createElement('div');
    textCol.className = 'flex flex-col gap-0.5 min-w-0 overflow-hidden';

    const username = document.createElement('span');
    username.className = 'text-[10px] text-white/30 font-semibold truncate';
    username.textContent = comment.user.username;

    const body = document.createElement('span');
    body.className = 'text-[12px] text-white/80 font-medium leading-snug';
    body.style.display = '-webkit-box';
    body.style.webkitLineClamp = '2';
    body.style.webkitBoxOrient = 'vertical';
    body.style.overflow = 'hidden';
    body.textContent = comment.body;

    textCol.appendChild(username);
    textCol.appendChild(body);

    if (comment.timestamp != null) {
      const ts = document.createElement('span');
      const sec = Math.floor(comment.timestamp / 1000);
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      ts.className = 'text-[9px] text-white/20 tabular-nums font-medium mt-0.5';
      ts.textContent = `${m}:${String(s).padStart(2, '0')}`;
      textCol.appendChild(ts);
    }

    el.appendChild(avatar);
    el.appendChild(textCol);
    container.appendChild(el);

    // Animate in
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.style.opacity = '1';
        el.style.transform = 'translateX(0)';
      });
    });
  } else {
    // Default centered mode (original)
    el.className = 'timed-comment flex items-center gap-2.5 bg-white/[0.08] backdrop-blur-xl border border-white/[0.08] shadow-[0_10px_40px_rgba(0,0,0,0.5)] pointer-events-auto transition-all duration-[400ms] cubic-bezier(0.16, 1, 0.3, 1) overflow-hidden whitespace-nowrap';
    
    el.style.opacity = '0';
    el.style.transform = 'scale(0.35)';
    el.style.borderRadius = '50%';
    el.style.maxWidth = '44px';
    el.style.padding = '8px';

    const avatar = document.createElement('img');
    avatar.src = art(comment.user.avatar_url, 'small') || '';
    avatar.className = 'w-[28px] h-[28px] rounded-full object-cover shrink-0';
    avatar.alt = '';

    const bodyWrap = document.createElement('div');
    bodyWrap.className = 'flex items-center gap-2 overflow-hidden opacity-0 transition-opacity duration-300 delay-250';
    bodyWrap.style.maxWidth = '380px';

    const body = document.createElement('span');
    body.className = 'text-[13px] text-white/90 font-semibold leading-snug truncate';
    body.textContent = comment.body;

    bodyWrap.appendChild(body);

    if (comment.timestamp != null) {
      const ts = document.createElement('span');
      const sec = Math.floor(comment.timestamp / 1000);
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      ts.className = 'text-[10px] text-white/35 tabular-nums shrink-0 font-medium';
      ts.textContent = `${m}:${String(s).padStart(2, '0')}`;
      bodyWrap.appendChild(ts);
    }

    el.appendChild(avatar);
    el.appendChild(bodyWrap);
    container.appendChild(el);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.style.opacity = '1';
        el.style.transform = 'scale(1)';
        el.style.borderRadius = '20px';
        el.style.maxWidth = '420px';
        el.style.padding = '8px 16px 8px 8px';
        bodyWrap.style.opacity = '1';
      });
    });
  }
}

function removePill(container: HTMLDivElement, pillId: number, mode: FloatingCommentsMode) {
  const el = container.querySelector(`[data-pill-id="${pillId}"]`) as HTMLElement | null;
  if (!el) return;
  
  if (mode === 'sidebar') {
    el.style.opacity = '0';
    el.style.transform = 'translateX(60px)';
    el.style.maxHeight = '0';
    el.style.padding = '0 14px';
    el.style.marginBottom = '0';
    el.style.borderWidth = '0';
  } else {
    el.style.opacity = '0';
    el.style.transform = 'scale(0.4)';
    el.style.borderRadius = '50%';
    el.style.maxWidth = '44px';
    el.style.padding = '8px';
    
    const bodyWrap = el.querySelector('div');
    if (bodyWrap) bodyWrap.style.opacity = '0';
  }

  setTimeout(() => el.remove(), 400);
}
