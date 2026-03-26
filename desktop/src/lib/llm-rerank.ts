import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isTauri } from '@tauri-apps/api/core';
import type { Track } from '../stores/player';

interface LlmRerankParams {
  endpoint: string;
  model: string;
  tracks: Track[];
  moodHint?: string;
  modeHint?: string;
  timeoutMs?: number;
}

interface LlmResponse {
  response?: string;
}

function buildPrompt(tracks: Track[], moodHint?: string, modeHint?: string): string {
  const compact = tracks.map((track, index) => ({
    i: index,
    title: track.title,
    artist: track.user?.username || '',
    genre: track.genre || '',
    plays: track.playback_count || 0,
    likes: track.likes_count || track.favoritings_count || 0,
    tags: (track.tag_list || '').slice(0, 140),
  }));

  return [
    'You are ranking music recommendations for a SoundCloud desktop user.',
    `Mode: ${modeHint || 'favorite'}.`,
    `Mood: ${moodHint || 'neutral'}.`,
    'Prioritize variety, strong artist/title quality, and mood fit. Penalize low quality "type beat" spam.',
    'Return strict JSON only: {"order":[indices in best-first order]}',
    JSON.stringify(compact),
  ].join('\n');
}

async function postJson(url: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const req = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  };

  if (isTauri()) {
    try {
      return await tauriFetch(url, req);
    } catch {}
  }

  return fetch(url, req);
}

function parseOrder(raw: string, max: number): number[] {
  try {
    const parsed = JSON.parse(raw) as { order?: number[] };
    const order = Array.isArray(parsed.order) ? parsed.order : [];
    const seen = new Set<number>();
    const clean: number[] = [];
    for (const idx of order) {
      if (!Number.isInteger(idx)) continue;
      if (idx < 0 || idx >= max) continue;
      if (seen.has(idx)) continue;
      seen.add(idx);
      clean.push(idx);
    }
    return clean;
  } catch {
    return [];
  }
}

export async function rerankTracksWithLLM(params: LlmRerankParams): Promise<Track[]> {
  const { endpoint, model, tracks, moodHint, modeHint, timeoutMs = 4500 } = params;
  if (!endpoint || !model || tracks.length < 6) return tracks;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${endpoint.replace(/\/$/, '')}/api/generate`;
    const prompt = buildPrompt(tracks, moodHint, modeHint);
    const res = await postJson(
      url,
      {
        model,
        prompt,
        stream: false,
        format: 'json',
        options: {
          temperature: 0.1,
          top_p: 0.9,
        },
      },
      controller.signal,
    );

    if (!res.ok) return tracks;
    const data = (await res.json()) as LlmResponse;
    const order = parseOrder(data.response || '', tracks.length);
    if (order.length === 0) return tracks;

    const used = new Set(order);
    const reordered = order.map((idx) => tracks[idx]);
    for (let i = 0; i < tracks.length; i++) {
      if (!used.has(i)) reordered.push(tracks[i]);
    }
    return reordered;
  } catch {
    return tracks;
  } finally {
    clearTimeout(timer);
  }
}
