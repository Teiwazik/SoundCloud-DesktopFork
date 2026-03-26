import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type { Track } from '../stores/player';
import type { AudioFeatures } from './audio-analyser';

export interface QdrantConfig {
  url: string;
  apiKey?: string;
  collection: string;
}

export interface QdrantScoredPoint {
  id: number | string;
  score?: number;
  payload?: Record<string, unknown>;
}

export interface QdrantRecommendOptions {
  positive: (number | number[])[];
  negative: (number | number[])[];
  limit: number;
  targetVector?: number[];
}

export class QdrantClient {
  private config: QdrantConfig;
  private dims = 96;

  constructor(config: QdrantConfig) {
    this.config = config;
  }

  private hash(str: string, numDims: number) {
    let h1 = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h1 ^= str.charCodeAt(i);
      h1 = Math.imul(h1, 0x01000193);
    }
    const dim = (h1 >>> 0) % numDims;
    let h2 = 0;
    for (let i = str.length - 1; i >= 0; i--) {
      h2 = Math.imul(h2 ^ str.charCodeAt(i), 0x5bd1e995);
    }
    return { dim, sign: h2 & 1 ? 1.0 : -1.0 };
  }

  private normalize(vec: Float32Array) {
    let n = 0;
    for (let i = 0; i < vec.length; i++) n += vec[i] * vec[i];
    n = Math.sqrt(n);
    if (n > 1e-9) for (let i = 0; i < vec.length; i++) vec[i] /= n;
    return vec;
  }

  vectorize(track: Track, features: AudioFeatures | null): Float32Array {
    const v = new Float32Array(this.dims);

    // [0..31] Text fingerprint
    const textParts: string[] = [];
    const artist = (track.user?.username || '').toLowerCase().trim();
    if (artist) textParts.push(artist, artist, artist);

    const title = (track.title || '').toLowerCase();
    title
      .split(/[\s\-_,.!?()[\]{}:;'"/\\+=#@&*|~`<>]+/)
      .filter(w => w.length > 2)
      .forEach(w => {
        textParts.push(w);
      });

    const genre = (track.genre || '').toLowerCase().trim();
    if (genre) textParts.push(genre, genre);

    (track.tag_list || '').split(/[\s,]+/).forEach(t => {
      const tag = t.toLowerCase().trim();
      if (tag.length > 2) textParts.push(tag);
    });

    for (const part of textParts) {
      const { dim, sign } = this.hash(part, 32);
      v[dim] += sign;
    }

    // [32..39] Artist fingerprint
    if (artist) {
      for (let i = 0; i < artist.length && i < 8; i++) {
        const { dim, sign } = this.hash(`${artist}_art_${i}`, 8);
        v[32 + dim] += sign * (1 + i * 0.1);
      }
      const { dim, sign } = this.hash(artist, 8);
      v[32 + dim] += sign * 2;
    }

    // [40..41] BPM cycle
    const bpm = features?.bpm || track.bpm || 0;
    if (bpm > 30 && bpm < 300) {
      const n = (bpm - 30) / 270;
      v[40] = Math.sin(n * Math.PI * 2);
      v[41] = Math.cos(n * Math.PI * 2);
    }

    // [42..46] Duration + popularity
    if (track.duration > 0) {
      v[42] = Math.min(1, Math.log(track.duration / 1000 + 1) / Math.log(601));
    }
    const plays = track.playback_count || 0;
    const likes = track.likes_count || track.favoritings_count || 0;
    v[43] = Math.min(1, Math.log1p(plays) / 14);
    v[44] = Math.min(1, Math.log1p(likes) / 12);
    v[45] = plays > 0 ? Math.min(1, (likes / plays) * 5) : 0;
    v[46] = Math.min(1, Math.log1p(track.user?.followers_count || 0) / 14);

    // [47..55] Metadata + text priors
    const titleLen = Math.min(1, (track.title?.length || 0) / 80);
    const hasFeat = /\b(ft\.?|feat\.?|featuring)\b/i.test(track.title || '') ? 1 : 0;
    const hasRemix = /\b(remix|edit|vip|bootleg|version)\b/i.test(track.title || '') ? 1 : 0;
    const hasLive = /\b(live|acoustic|session)\b/i.test(track.title || '') ? 1 : 0;
    const hasTypeBeat = /\b(type\s*beat|instrumental|prod)\b/i.test(track.title || '') ? 1 : 0;
    v[47] = titleLen;
    v[48] = hasFeat;
    v[49] = hasRemix;
    v[50] = hasLive;
    v[51] = hasTypeBeat;

    const postedAt = track.created_at ? Date.parse(track.created_at) : 0;
    if (!Number.isNaN(postedAt) && postedAt > 0) {
      const ageDays = (Date.now() - postedAt) / 86400000;
      v[52] = Math.max(0, Math.min(1, 1 - ageDays / 3650));
    }
    v[53] = (track.comment_count || 0) > 0 ? Math.min(1, Math.log1p(track.comment_count || 0) / 10) : 0;
    v[54] = (track.reposts_count || 0) > 0 ? Math.min(1, Math.log1p(track.reposts_count || 0) / 9) : 0;
    v[55] = (track.permalink_url || '').includes('/sets/') ? 0.15 : 0;

    // [56..63] Tag hashing extension
    const tagParts = (track.tag_list || '')
      .split(/[\s,]+/)
      .map((t) => t.toLowerCase().trim())
      .filter((t) => t.length > 1)
      .slice(0, 24);
    for (const tag of tagParts) {
      const { dim, sign } = this.hash(`tag:${tag}`, 8);
      v[56 + dim] += sign;
    }

    // [64..79] Core audio features
    if (features) {
      v[64] = Math.min(1, features.rmsEnergy * 2);
      v[65] = Math.min(1, features.centroid * 5);
      v[66] = Math.min(1, features.flatness || 0);
      v[67] = Math.min(1, features.rolloff || 0);
      v[68] = Math.min(1, features.flux * 100);
      v[69] = features.valence;
      v[70] = features.arousal;
      v[71] = features.bpm > 0 ? 0.8 : 0.2;
      v[72] = Math.min(1, ((features.bpm || 0) / 220));
      v[73] = Math.min(1, (features.valence || 0) * (features.arousal || 0));
      v[74] = Math.min(1, (features.rmsEnergy || 0) * (1 - (features.flatness || 0) * 0.4));
      v[75] = Math.min(1, (features.rolloff || 0) * (features.centroid || 0));
      v[76] = Math.min(1, (features.spectralContrast || 0) / 1.5);
      v[77] = Math.min(1, features.subBass || 0);
      v[78] = Math.min(1, features.midPresence || 0);
      v[79] = Math.min(1, features.dynamicRange || 0);
    }

    // [80..95] Spectral/rhythm + interaction terms
    if (features) {
      const spectralContrast = Math.min(1, (features.spectralContrast || 0) / 1.5);
      const subBass = Math.min(1, features.subBass || 0);
      const midPresence = Math.min(1, features.midPresence || 0);
      const dynamicRange = Math.min(1, features.dynamicRange || 0);
      const rhythmicStability = Math.min(1, features.rhythmicStability || 0);

      v[80] = spectralContrast;
      v[81] = subBass;
      v[82] = midPresence;
      v[83] = dynamicRange;
      v[84] = rhythmicStability;
      v[85] = Math.min(1, subBass * (features.rmsEnergy || 0) * 2);
      v[86] = Math.min(1, midPresence * (features.centroid || 0) * 2);
      v[87] = Math.min(1, spectralContrast * (features.flux || 0) * 120);
      v[88] = Math.min(1, dynamicRange * (features.arousal || 0));
      v[89] = Math.min(1, rhythmicStability * (1 - (features.flux || 0) * 60));
      v[90] = Math.min(1, ((features.bpm || 0) > 0 ? Math.abs((features.bpm || 0) - 120) / 120 : 0));
      v[91] = Math.min(1, (features.valence || 0) * (1 - (features.flatness || 0)));
      v[92] = Math.min(1, (features.arousal || 0) * (features.rmsEnergy || 0));
      v[93] = Math.min(1, (features.rolloff || 0) * (1 - subBass));
      v[94] = Math.min(1, (features.centroid || 0) * dynamicRange);
      v[95] = Math.min(1, (features.flux || 0) * 80 * (1 - rhythmicStability));
    }

    return this.normalize(v);
  }

  async req(method: string, path: string, body: unknown = null) {
    const url = `${this.config.url.replace(/\/$/, '')}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.apiKey?.trim()) {
      headers['api-key'] = this.config.apiKey.trim();
    }
    const request = {
      method,
      headers,
      body: body ? JSON.stringify(body) : null,
    };

    let response: Response;
    try {
      response = await tauriFetch(url, request);
    } catch {
      response = await fetch(url, request);
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Qdrant error ${response.status}: ${text}`);
    }
    return response.json();
  }

  async initCollection() {
    try {
      const existing = await this.req('GET', `/collections/${this.config.collection}`);
      const size = existing?.result?.config?.params?.vectors?.size;
      if (typeof size === 'number' && size !== this.dims) {
        await this.req('DELETE', `/collections/${this.config.collection}`);
        await this.req('PUT', `/collections/${this.config.collection}`, {
          vectors: { size: this.dims, distance: 'Cosine' },
          optimizers_config: { default_segment_number: 2 },
        });
      }
    } catch {
      await this.req('PUT', `/collections/${this.config.collection}`, {
        vectors: { size: this.dims, distance: 'Cosine' },
        optimizers_config: { default_segment_number: 2 },
      });
    }
  }

  async upsert(tracks: { track: Track; features: AudioFeatures | null; isLiked: boolean }[]) {
    const points = tracks.map(t => ({
      id: this.urnToId(t.track.urn),
      vector: Array.from(this.vectorize(t.track, t.features)),
      payload: {
        urn: t.track.urn,
        id: t.track.id,
        title: t.track.title,
        artist: t.track.user?.username || '',
        user_urn: t.track.user?.urn || '',
        user_avatar_url: t.track.user?.avatar_url || '',
        user_permalink_url: t.track.user?.permalink_url || '',
        duration: t.track.duration || 0,
        playback_count: t.track.playback_count || 0,
        likes_count: t.track.likes_count || t.track.favoritings_count || 0,
        favoritings_count: t.track.favoritings_count || t.track.likes_count || 0,
        reposts_count: t.track.reposts_count || 0,
        comment_count: t.track.comment_count || 0,
        created_at: t.track.created_at || '',
        genre: t.track.genre || '',
        tag_list: t.track.tag_list || '',
        isLiked: t.isLiked,
        artwork_url: t.track.artwork_url,
        bpm: t.features?.bpm || t.track.bpm || 0,
        valence: t.features?.valence ?? 0.5,
        arousal: t.features?.arousal ?? 0.5,
        spectral_contrast: t.features?.spectralContrast ?? 0,
        sub_bass: t.features?.subBass ?? 0,
        mid_presence: t.features?.midPresence ?? 0,
        dynamic_range: t.features?.dynamicRange ?? 0,
        rhythmic_stability: t.features?.rhythmicStability ?? 0,
      },
    }));

    await this.req('PUT', `/collections/${this.config.collection}/points`, { points });
  }

  async recommend(options: QdrantRecommendOptions): Promise<QdrantScoredPoint[]> {
    const res = await this.req('POST', `/collections/${this.config.collection}/points/recommend`, {
      positive: options.positive,
      negative: options.negative,
      limit: options.limit,
      with_payload: true,
      strategy: 'best_score',
    });
    return (res.result || []) as QdrantScoredPoint[];
  }

  async search(vector: number[] | Float32Array, limit: number): Promise<QdrantScoredPoint[]> {
    const res = await this.req('POST', `/collections/${this.config.collection}/points/search`, {
      vector: Array.from(vector),
      limit,
      with_payload: true,
    });
    return (res.result || []) as QdrantScoredPoint[];
  }

  async recommendHybrid(options: QdrantRecommendOptions): Promise<QdrantScoredPoint[]> {
    const recommended = await this.recommend(options);
    if (!options.targetVector?.length) return recommended;

    try {
      const searched = await this.search(options.targetVector, Math.max(options.limit, 20));
      const merged = new Map<number | string, QdrantScoredPoint>();

      for (const p of recommended) {
        merged.set(p.id, { ...p, score: (p.score || 0) * 1.12 });
      }

      for (const p of searched) {
        const prev = merged.get(p.id);
        if (!prev) {
          merged.set(p.id, { ...p, score: (p.score || 0) * 0.94 });
          continue;
        }
        merged.set(p.id, {
          ...prev,
          payload: prev.payload || p.payload,
          score: (prev.score || 0) + (p.score || 0) * 0.5,
        });
      }

      return [...merged.values()]
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, options.limit);
    } catch {
      return recommended;
    }
  }

  buildTargetVector(params: {
    mode?: 'favorite' | 'discover' | 'popular';
    tags?: string[];
    regionHints?: string[];
  }): number[] {
    const v = new Float32Array(this.dims);
    const tags = params.tags || [];
    const mode = params.mode || 'favorite';

    for (const tag of tags) {
      const token = tag.toLowerCase().trim();
      if (!token) continue;
      const text = this.hash(token, 32);
      v[text.dim] += text.sign * 1.1;
      const ext = this.hash(`tag:${token}`, 8);
      v[56 + ext.dim] += ext.sign * 1.4;
    }

    if (mode === 'discover') {
      v[43] = 0.25;
      v[44] = 0.2;
      v[52] = 0.85;
      v[54] = 0.2;
      v[80] = 0.42;
      v[84] = 0.6;
    } else if (mode === 'popular') {
      v[43] = 0.98;
      v[44] = 0.92;
      v[45] = 0.74;
      v[54] = 0.7;
      v[84] = 0.55;
    } else {
      v[43] = 0.72;
      v[44] = 0.68;
      v[52] = 0.55;
      v[84] = 0.5;
    }

    for (const hint of params.regionHints || []) {
      const h = this.hash(`region:${hint.toLowerCase()}`, 8);
      v[56 + h.dim] += h.sign * 0.9;
    }

    return Array.from(this.normalize(v));
  }

  urnToId(urn: string): number {
    const m = urn.match(/(\d+)/g);
    return m ? parseInt(m[m.length - 1], 10) : 0;
  }
}
