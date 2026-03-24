import { listen } from '@tauri-apps/api/event';

export interface AudioFeatures {
  rmsEnergy: number;
  centroid: number;
  flatness: number;
  rolloff: number;
  flux: number;
  valence: number;
  arousal: number;
  bpm: number;
}

interface Snapshot {
  energy: number;
  centroid: number;
  flatness: number;
  rolloff: number;
  flux: number;
}

class AudioAnalyserService {
  private prevBins = new Uint8Array(64);
  private currentSnapshot: Snapshot | null = null;
  private history: Snapshot[] = [];
  private trackUrn: string | null = null;
  private trackFrames = 0;
  private trackAccumulator: Snapshot = { energy: 0, centroid: 0, flatness: 0, rolloff: 0, flux: 0 };
  private cache = new Map<string, AudioFeatures>();

  // Onset detection for BPM
  private fluxHistory: number[] = [];
  private onsets: number[] = [];
  private lastOnsetTime = 0;

  constructor() {
    listen<number[]>('audio:visualizer', (event) => {
      this.processBins(new Uint8Array(event.payload));
    });
  }

  setTrack(urn: string | null) {
    if (this.trackUrn && this.trackFrames > 20) {
      this.finalizeTrack();
    }
    this.trackUrn = urn;
    this.trackFrames = 0;
    this.trackAccumulator = { energy: 0, centroid: 0, flatness: 0, rolloff: 0, flux: 0 };
    this.onsets = [];
    this.fluxHistory = [];
  }

  private processBins(bins: Uint8Array) {
    let energy = 0;
    let weightedSum = 0;
    let logSum = 0;
    let arithmeticMean = 0;
    let nonZero = 0;

    for (let i = 0; i < 64; i++) {
      const val = bins[i] / 255;
      energy += val;
      weightedSum += i * val;
      arithmeticMean += val;
      if (val > 0.001) {
        logSum += Math.log(val);
        nonZero++;
      }
    }

    const centroid = energy > 0 ? weightedSum / (64 * energy) : 0;
    const geometricMean = nonZero > 0 ? Math.exp(logSum / nonZero) : 0;
    const flatness = (arithmeticMean / 64) > 0.001 ? geometricMean / (arithmeticMean / 64) : 0;

    const threshold85 = energy * 0.85;
    let cumEnergy = 0;
    let rolloff = 0;
    for (let i = 0; i < 64; i++) {
       cumEnergy += bins[i] / 255;
       if (cumEnergy >= threshold85) {
         rolloff = i / 64;
         break;
       }
    }

    let flux = 0;
    for (let i = 0; i < 64; i++) {
      const diff = (bins[i] - this.prevBins[i]) / 255;
      flux += diff * diff;
    }
    flux = Math.sqrt(flux / 64);
    this.prevBins.set(bins);

    const snapshot: Snapshot = { energy, centroid, flatness, rolloff, flux };
    this.currentSnapshot = snapshot;

    if (this.trackUrn) {
      this.trackFrames++;
      this.trackAccumulator.energy += energy;
      this.trackAccumulator.centroid += centroid;
      this.trackAccumulator.flatness += flatness;
      this.trackAccumulator.rolloff += rolloff;
      this.trackAccumulator.flux += flux;

      // Pulse/Onset detection
      this.fluxHistory.push(flux);
      if (this.fluxHistory.length > 30) this.fluxHistory.shift();
      
      if (this.fluxHistory.length >= 5) {
        const sorted = [...this.fluxHistory].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const threshold = median * 2.5 + 0.002;
        const now = Date.now();
        if (flux > threshold && (now - this.lastOnsetTime) > 200) {
          this.onsets.push(now);
          this.lastOnsetTime = now;
          if (this.onsets.length > 60) this.onsets.shift();
        }
      }
    }

    this.history.push(snapshot);
    if (this.history.length > 100) this.history.shift();
  }

  private finalizeTrack() {
    if (!this.trackUrn || this.trackFrames < 20) return;

    const avg = {
      energy: this.trackAccumulator.energy / this.trackFrames,
      centroid: this.trackAccumulator.centroid / this.trackFrames,
      flatness: this.trackAccumulator.flatness / this.trackFrames,
      rolloff: this.trackAccumulator.rolloff / this.trackFrames,
      flux: this.trackAccumulator.flux / this.trackFrames,
    };

    const { valence, arousal } = this.computeMood(avg);
    const bpm = this.calculateBPM();

    this.cache.set(this.trackUrn, {
      rmsEnergy: avg.energy,
      centroid: avg.centroid,
      flatness: avg.flatness,
      rolloff: avg.rolloff,
      flux: avg.flux,
      valence,
      arousal,
      bpm
    });
  }

  private computeMood(avg: Snapshot) {
    // Ported from MusiCenter components/audioanalyser.js
    let arousal = 0;
    arousal += Math.min(1, avg.energy * 0.5) * 0.3; // original used rmsEnergy * 8, but avg.energy here is larger
    arousal += Math.min(1, avg.centroid * 5) * 0.2;
    arousal += Math.min(1, avg.flux * 50) * 0.2;
    
    let valence = 0.5;
    valence += (avg.centroid - 0.15) * 1.0;
    valence += (avg.flatness - 0.3) * 0.4;
    valence += (avg.rolloff - 0.3) * 0.3;

    return {
      valence: Math.max(0, Math.min(1, valence)),
      arousal: Math.max(0, Math.min(1, arousal)),
    };
  }

  private calculateBPM(): number {
    if (this.onsets.length < 8) return 0;
    const iois = [];
    for (let i = 1; i < this.onsets.length; i++) {
      const d = this.onsets[i] - this.onsets[i - 1];
      if (d >= 300 && d <= 1200) iois.push(d);
    }
    if (iois.length < 4) return 0;
    
    // Simple median-based BPM
    iois.sort((a, b) => a - b);
    const medianIOI = iois[Math.floor(iois.length / 2)];
    let bpm = Math.round(60000 / medianIOI);
    if (bpm < 70) bpm *= 2;
    if (bpm > 200) bpm = Math.round(bpm / 2);
    return bpm;
  }

  getFeatures(urn: string): AudioFeatures | null {
    return this.cache.get(urn) || null;
  }

  getCurrentFeatures(): AudioFeatures | null {
    if (!this.currentSnapshot) return null;
    const s = this.currentSnapshot;
    const { valence, arousal } = this.computeMood(s);
    return {
      rmsEnergy: s.energy,
      centroid: s.centroid,
      flatness: s.flatness,
      rolloff: s.rolloff,
      flux: s.flux,
      valence,
      arousal,
      bpm: this.calculateBPM(),
    };
  }
}

export const audioAnalyser = new AudioAnalyserService();
