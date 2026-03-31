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
  spectralContrast?: number;
  subBass?: number;
  midPresence?: number;
  dynamicRange?: number;
  rhythmicStability?: number;
}

interface Snapshot {
  energy: number;
  centroid: number;
  flatness: number;
  rolloff: number;
  flux: number;
  spectralContrast: number;
  subBass: number;
  midPresence: number;
  dynamicRange: number;
  rhythmicStability: number;
}

type WorkerInputMessage =
  | {
      type: 'set-track';
      urn: string | null;
    }
  | {
      type: 'visualizer';
      bins: ArrayBuffer;
    }
  | {
      type: 'finalize-current';
    };

type WorkerOutputMessage =
  | {
      type: 'track-features';
      urn: string;
      features: AudioFeatures;
    }
  | {
      type: 'current-features';
      features: AudioFeatures | null;
    };

class AudioAnalyserService {
  private static readonly MAX_FEATURE_CACHE = 600;
  private prevBins = new Uint8Array(64);
  private currentSnapshot: Snapshot | null = null;
  private trackUrn: string | null = null;
  private trackFrames = 0;
  private trackAccumulator: Snapshot = this.createEmptySnapshot();
  private cache = new Map<string, AudioFeatures>();
  private worker: Worker | null = null;
  private workerMode = false;
  private workerCurrentFeatures: AudioFeatures | null = null;

  // Onset detection for BPM
  private fluxHistory: number[] = [];
  private onsets: number[] = [];
  private lastOnsetTime = 0;

  constructor() {
    this.initWorker();

    listen<number[]>('audio:visualizer', (event) => {
      const bins = new Uint8Array(event.payload);

      if (this.workerMode && this.worker) {
        this.worker.postMessage(
          {
            type: 'visualizer',
            bins: bins.buffer,
          } satisfies WorkerInputMessage,
          [bins.buffer],
        );
        return;
      }

      this.processBins(bins);
    });
  }

  private initWorker() {
    if (typeof Worker === 'undefined') return;

    try {
      const worker = new Worker(new URL('./audio-analyser.worker.ts', import.meta.url), {
        type: 'module',
      });

      worker.onmessage = (event: MessageEvent<WorkerOutputMessage>) => {
        const message = event.data;
        if (message.type === 'track-features') {
          this.rememberFeatures(message.urn, message.features);
          return;
        }
        this.workerCurrentFeatures = message.features;
      };

      worker.onerror = (event) => {
        console.warn('[AudioAnalyser] Worker failed, falling back to main thread', event.message);
        this.disableWorker();
      };

      this.worker = worker;
      this.workerMode = true;
    } catch (error) {
      console.warn('[AudioAnalyser] Worker init failed, falling back to main thread', error);
      this.disableWorker();
    }
  }

  private disableWorker() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    this.workerMode = false;
    this.workerCurrentFeatures = null;
    this.prevBins.fill(0);
    this.currentSnapshot = null;
    this.trackFrames = 0;
    this.trackAccumulator = this.createEmptySnapshot();
    this.fluxHistory = [];
    this.onsets = [];
    this.lastOnsetTime = 0;
  }

  private createEmptySnapshot(): Snapshot {
    return {
      energy: 0,
      centroid: 0,
      flatness: 0,
      rolloff: 0,
      flux: 0,
      spectralContrast: 0,
      subBass: 0,
      midPresence: 0,
      dynamicRange: 0,
      rhythmicStability: 0,
    };
  }

  private rememberFeatures(urn: string, features: AudioFeatures) {
    if (this.cache.has(urn)) {
      this.cache.delete(urn);
    }
    this.cache.set(urn, features);

    while (this.cache.size > AudioAnalyserService.MAX_FEATURE_CACHE) {
      const oldestKey = this.cache.keys().next().value;
      if (!oldestKey) break;
      this.cache.delete(oldestKey);
    }
  }

  setTrack(urn: string | null) {
    if (this.workerMode && this.worker) {
      this.trackUrn = urn;
      this.trackFrames = 0;
      this.currentSnapshot = null;
      this.workerCurrentFeatures = null;
      this.worker.postMessage({
        type: 'set-track',
        urn,
      } satisfies WorkerInputMessage);
      return;
    }

    if (this.trackUrn && this.trackFrames > 20) {
      this.finalizeTrack();
    }
    this.trackUrn = urn;
    this.trackFrames = 0;
    this.currentSnapshot = null;
    this.trackAccumulator = this.createEmptySnapshot();
    this.onsets = [];
    this.fluxHistory = [];
    this.prevBins.fill(0);
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

    let lowEnergy = 0;
    let midEnergy = 0;
    let highEnergy = 0;
    let maxBin = 0;
    let minBin = 1;
    let sumSq = 0;

    for (let i = 0; i < 64; i++) {
      const val = bins[i] / 255;
      sumSq += val * val;
      if (val > maxBin) maxBin = val;
      if (val < minBin) minBin = val;
      if (i < 10) lowEnergy += val;
      else if (i < 36) midEnergy += val;
      else highEnergy += val;
    }

    const totalBandEnergy = lowEnergy + midEnergy + highEnergy;
    const subBass = totalBandEnergy > 0 ? lowEnergy / totalBandEnergy : 0;
    const midPresence = totalBandEnergy > 0 ? midEnergy / totalBandEnergy : 0;
    const spectralContrast = (highEnergy + 1e-4) / (lowEnergy + 1e-4);
    const meanBin = arithmeticMean / 64;
    const variance = Math.max(0, sumSq / 64 - meanBin * meanBin);
    const dynamicRange = Math.min(1, Math.sqrt(variance) * 2.5 + (maxBin - minBin) * 0.2);
    const rhythmicStability = this.fluxHistory.length > 6
      ? Math.max(0, 1 - Math.min(1, this.std(this.fluxHistory) * 8))
      : 0.5;

    const snapshot: Snapshot = {
      energy,
      centroid,
      flatness,
      rolloff,
      flux,
      spectralContrast: Math.min(1.5, spectralContrast),
      subBass: Math.min(1, subBass),
      midPresence: Math.min(1, midPresence),
      dynamicRange,
      rhythmicStability,
    };
    this.currentSnapshot = snapshot;

    if (this.trackUrn) {
      this.trackFrames++;
      this.trackAccumulator.energy += energy;
      this.trackAccumulator.centroid += centroid;
      this.trackAccumulator.flatness += flatness;
      this.trackAccumulator.rolloff += rolloff;
      this.trackAccumulator.flux += flux;
      this.trackAccumulator.spectralContrast += snapshot.spectralContrast;
      this.trackAccumulator.subBass += snapshot.subBass;
      this.trackAccumulator.midPresence += snapshot.midPresence;
      this.trackAccumulator.dynamicRange += snapshot.dynamicRange;
      this.trackAccumulator.rhythmicStability += snapshot.rhythmicStability;

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
  }

  private finalizeTrack() {
    if (!this.trackUrn || this.trackFrames < 20) return;

    const avg = {
      energy: this.trackAccumulator.energy / this.trackFrames,
      centroid: this.trackAccumulator.centroid / this.trackFrames,
      flatness: this.trackAccumulator.flatness / this.trackFrames,
      rolloff: this.trackAccumulator.rolloff / this.trackFrames,
      flux: this.trackAccumulator.flux / this.trackFrames,
      spectralContrast: this.trackAccumulator.spectralContrast / this.trackFrames,
      subBass: this.trackAccumulator.subBass / this.trackFrames,
      midPresence: this.trackAccumulator.midPresence / this.trackFrames,
      dynamicRange: this.trackAccumulator.dynamicRange / this.trackFrames,
      rhythmicStability: this.trackAccumulator.rhythmicStability / this.trackFrames,
    };

    const { valence, arousal } = this.computeMood(avg);
    const bpm = this.calculateBPM();

    const next: AudioFeatures = {
      rmsEnergy: avg.energy,
      centroid: avg.centroid,
      flatness: avg.flatness,
      rolloff: avg.rolloff,
      flux: avg.flux,
      valence,
      arousal,
      bpm,
      spectralContrast: avg.spectralContrast,
      subBass: avg.subBass,
      midPresence: avg.midPresence,
      dynamicRange: avg.dynamicRange,
      rhythmicStability: avg.rhythmicStability,
    };

    this.rememberFeatures(this.trackUrn, next);
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

  private std(values: number[]): number {
    if (values.length === 0) return 0;
    let mean = 0;
    for (const v of values) mean += v;
    mean /= values.length;
    let varSum = 0;
    for (const v of values) {
      const d = v - mean;
      varSum += d * d;
    }
    return Math.sqrt(varSum / values.length);
  }

  finalizeCurrentTrackIfReady() {
    if (this.workerMode && this.worker) {
      this.worker.postMessage({ type: 'finalize-current' } satisfies WorkerInputMessage);
      return;
    }

    if (!this.trackUrn) return;
    if (this.trackFrames < 20) return;
    this.finalizeTrack();
  }

  getFeatures(urn: string): AudioFeatures | null {
    return this.cache.get(urn) || null;
  }

  getCurrentFeatures(): AudioFeatures | null {
    if (this.workerMode) {
      return this.workerCurrentFeatures;
    }

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
      spectralContrast: s.spectralContrast,
      subBass: s.subBass,
      midPresence: s.midPresence,
      dynamicRange: s.dynamicRange,
      rhythmicStability: s.rhythmicStability,
    };
  }
}

export const audioAnalyser = new AudioAnalyserService();
