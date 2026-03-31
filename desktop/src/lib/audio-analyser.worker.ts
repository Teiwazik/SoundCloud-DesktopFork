/// <reference lib="webworker" />

export {};

interface AudioFeatures {
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

const CURRENT_FEATURE_EMIT_INTERVAL_MS = 320;

const workerScope = self as DedicatedWorkerGlobalScope;

const prevBins = new Uint8Array(64);
let currentSnapshot: Snapshot | null = null;
let trackUrn: string | null = null;
let trackFrames = 0;
let trackAccumulator = createEmptySnapshot();
let fluxHistory: number[] = [];
let onsets: number[] = [];
let lastOnsetTime = 0;
let lastCurrentEmitAt = 0;

workerScope.onmessage = (event: MessageEvent<WorkerInputMessage>) => {
  const message = event.data;

  if (message.type === 'set-track') {
    setTrack(message.urn);
    return;
  }

  if (message.type === 'finalize-current') {
    finalizeTrack();
    return;
  }

  const bins = new Uint8Array(message.bins);
  if (bins.length < 64) return;
  processBins(bins);
};

function createEmptySnapshot(): Snapshot {
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

function setTrack(urn: string | null) {
  if (trackUrn && trackFrames > 20) {
    finalizeTrack();
  }

  trackUrn = urn;
  trackFrames = 0;
  trackAccumulator = createEmptySnapshot();
  fluxHistory = [];
  onsets = [];
  lastOnsetTime = 0;
  prevBins.fill(0);
  currentSnapshot = null;
  emitCurrentFeatures(null);
}

function processBins(bins: Uint8Array) {
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
  const flatness = arithmeticMean / 64 > 0.001 ? geometricMean / (arithmeticMean / 64) : 0;

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
    const diff = (bins[i] - prevBins[i]) / 255;
    flux += diff * diff;
  }
  flux = Math.sqrt(flux / 64);
  prevBins.set(bins);

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
  const rhythmicStability =
    fluxHistory.length > 6 ? Math.max(0, 1 - Math.min(1, std(fluxHistory) * 8)) : 0.5;

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
  currentSnapshot = snapshot;

  if (trackUrn) {
    trackFrames++;
    trackAccumulator.energy += energy;
    trackAccumulator.centroid += centroid;
    trackAccumulator.flatness += flatness;
    trackAccumulator.rolloff += rolloff;
    trackAccumulator.flux += flux;
    trackAccumulator.spectralContrast += snapshot.spectralContrast;
    trackAccumulator.subBass += snapshot.subBass;
    trackAccumulator.midPresence += snapshot.midPresence;
    trackAccumulator.dynamicRange += snapshot.dynamicRange;
    trackAccumulator.rhythmicStability += snapshot.rhythmicStability;

    fluxHistory.push(flux);
    if (fluxHistory.length > 30) fluxHistory.shift();

    if (fluxHistory.length >= 5) {
      const sorted = [...fluxHistory].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const threshold = median * 2.5 + 0.002;
      const now = Date.now();
      if (flux > threshold && now - lastOnsetTime > 200) {
        onsets.push(now);
        lastOnsetTime = now;
        if (onsets.length > 60) onsets.shift();
      }
    }
  }

  const now = Date.now();
  if (now - lastCurrentEmitAt >= CURRENT_FEATURE_EMIT_INTERVAL_MS) {
    lastCurrentEmitAt = now;
    emitCurrentFeatures(getCurrentFeatures());
  }
}

function finalizeTrack() {
  if (!trackUrn || trackFrames < 20) return;

  const avg = {
    energy: trackAccumulator.energy / trackFrames,
    centroid: trackAccumulator.centroid / trackFrames,
    flatness: trackAccumulator.flatness / trackFrames,
    rolloff: trackAccumulator.rolloff / trackFrames,
    flux: trackAccumulator.flux / trackFrames,
    spectralContrast: trackAccumulator.spectralContrast / trackFrames,
    subBass: trackAccumulator.subBass / trackFrames,
    midPresence: trackAccumulator.midPresence / trackFrames,
    dynamicRange: trackAccumulator.dynamicRange / trackFrames,
    rhythmicStability: trackAccumulator.rhythmicStability / trackFrames,
  };

  const mood = computeMood(avg);
  const bpm = calculateBPM();
  emitMessage({
    type: 'track-features',
    urn: trackUrn,
    features: {
      rmsEnergy: avg.energy,
      centroid: avg.centroid,
      flatness: avg.flatness,
      rolloff: avg.rolloff,
      flux: avg.flux,
      valence: mood.valence,
      arousal: mood.arousal,
      bpm,
      spectralContrast: avg.spectralContrast,
      subBass: avg.subBass,
      midPresence: avg.midPresence,
      dynamicRange: avg.dynamicRange,
      rhythmicStability: avg.rhythmicStability,
    },
  });
}

function computeMood(avg: Snapshot) {
  let arousal = 0;
  arousal += Math.min(1, avg.energy * 0.5) * 0.3;
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

function calculateBPM(): number {
  if (onsets.length < 8) return 0;
  const iois: number[] = [];
  for (let i = 1; i < onsets.length; i++) {
    const d = onsets[i] - onsets[i - 1];
    if (d >= 300 && d <= 1200) iois.push(d);
  }
  if (iois.length < 4) return 0;

  iois.sort((a, b) => a - b);
  const medianIOI = iois[Math.floor(iois.length / 2)];
  let bpm = Math.round(60000 / medianIOI);
  if (bpm < 70) bpm *= 2;
  if (bpm > 200) bpm = Math.round(bpm / 2);
  return bpm;
}

function std(values: number[]): number {
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

function getCurrentFeatures(): AudioFeatures | null {
  if (!currentSnapshot) return null;
  const mood = computeMood(currentSnapshot);
  return {
    rmsEnergy: currentSnapshot.energy,
    centroid: currentSnapshot.centroid,
    flatness: currentSnapshot.flatness,
    rolloff: currentSnapshot.rolloff,
    flux: currentSnapshot.flux,
    valence: mood.valence,
    arousal: mood.arousal,
    bpm: calculateBPM(),
    spectralContrast: currentSnapshot.spectralContrast,
    subBass: currentSnapshot.subBass,
    midPresence: currentSnapshot.midPresence,
    dynamicRange: currentSnapshot.dynamicRange,
    rhythmicStability: currentSnapshot.rhythmicStability,
  };
}

function emitCurrentFeatures(features: AudioFeatures | null) {
  emitMessage({
    type: 'current-features',
    features,
  });
}

function emitMessage(message: WorkerOutputMessage) {
  workerScope.postMessage(message);
}
