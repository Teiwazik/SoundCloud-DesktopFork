import type { Track } from '../stores/player';
import type { AudioFeatures } from './audio-analyser';

export interface QdrantConfig {
  url: string;
  apiKey: string;
  collection: string;
}

export class QdrantClient {
  private config: QdrantConfig;
  private dims = 72;

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

    // [0..31] Text Fingerprint
    const textParts: string[] = [];
    const artist = (track.user?.username || '').toLowerCase().trim();
    if (artist) textParts.push(artist, artist, artist);
    
    const title = (track.title || '').toLowerCase();
    title.split(/[\s\-_,.!?()[\]{}:;'"\/\\+=#@&*|~`<>]+/).filter(w => w.length > 2).forEach(w => textParts.push(w));
    
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

    // [32..39] Artist Fingerprint
    if (artist) {
      for (let i = 0; i < artist.length && i < 8; i++) {
        const { dim, sign } = this.hash(artist + '_art_' + i, 8);
        v[32 + dim] += sign * (1 + i * 0.1);
      }
      const { dim, sign } = this.hash(artist, 8);
      v[32 + dim] += sign * 2;
    }

    // [40..41] BPM
    const bpm = features?.bpm || track.bpm || 0;
    if (bpm > 30 && bpm < 300) {
      const n = (bpm - 30) / 270;
      v[40] = Math.sin(n * Math.PI * 2);
      v[41] = Math.cos(n * Math.PI * 2);
    }

    // [42] Duration
    if (track.duration > 0) {
      v[42] = Math.min(1, Math.log(track.duration / 1000 + 1) / Math.log(601));
    }

    // [43..46] Popularity
    const plays = track.playback_count || 0;
    const likes = track.likes_count || track.favoritings_count || 0;
    v[43] = Math.min(1, Math.log1p(plays) / 14);
    v[44] = Math.min(1, Math.log1p(likes) / 12);
    v[45] = plays > 0 ? Math.min(1, (likes / plays) * 5) : 0;
    v[46] = Math.min(1, Math.log1p(track.user?.followers_count || 0) / 14);

    // [47..51] Language/Mood (Simplified)
    // [52..63] Placeholder for extended metadata

    // [64..71] Audio features
    if (features) {
      v[64] = Math.min(1, features.rmsEnergy * 2);
      v[65] = Math.min(1, features.centroid * 5);
      v[66] = features.flatness;
      v[67] = features.rolloff;
      v[68] = Math.min(1, features.flux * 100);
      v[69] = features.valence;
      v[70] = features.arousal;
      v[71] = features.bpm > 0 ? 0.8 : 0.2;
    }

    return this.normalize(v);
  }

  async req(method: string, path: string, body: any = null) {
    const url = `${this.config.url.replace(/\/$/, '')}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'api-key': this.config.apiKey,
    };
    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : null,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Qdrant error ${response.status}: ${text}`);
    }
    return response.json();
  }

  async initCollection() {
    try {
      await this.req('GET', `/collections/${this.config.collection}`);
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
        title: t.track.title,
        artist: t.track.user?.username || '',
        genre: t.track.genre || '',
        isLiked: t.isLiked,
        artwork_url: t.track.artwork_url,
      },
    }));

    await this.req('PUT', `/collections/${this.config.collection}/points`, { points });
  }

  async recommend(options: { 
    positive: (number | number[])[], 
    negative: (number | number[])[], 
    limit: number 
  }) {
    const res = await this.req('POST', `/collections/${this.config.collection}/points/recommend`, {
      ...options,
      with_payload: true,
      strategy: 'best_score',
    });
    return res.result;
  }

  urnToId(urn: string): number {
    const m = urn.match(/(\d+)/g);
    return m ? parseInt(m[m.length - 1]) : 0;
  }
}
