import { listen } from '@tauri-apps/api/event';
import type React from 'react';
import { useEffect, useRef } from 'react';
import { isAppBackgrounded } from '../../lib/app-visibility';
import { useArtworkGradientPalette } from '../../lib/artwork-palette';
import { getAnimationFrameBudgetMs } from '../../lib/framerate';
import { usePlayerStore } from '../../stores/player';
import { useSettingsStore } from '../../stores/settings';

export type VisualizerStyle = 'Off' | 'Bars' | 'Wave' | 'Pulse';
type ThemeGradientType = 'linear' | 'radial';

interface VisualizerProps {
  className?: string;
  style?: VisualizerStyle;
}

type RgbColor = { r: number; g: number; b: number };
type GradientStop = { offset: number; color: RgbColor; alpha: number };
type VisualizerBinsListener = (payload: number[]) => void;

const visualizerBinsListeners = new Set<VisualizerBinsListener>();
let visualizerBinsUnlisten: (() => void) | null = null;
let visualizerBinsListenPromise: Promise<void> | null = null;

function ensureVisualizerBinsSubscription() {
  if (visualizerBinsUnlisten || visualizerBinsListenPromise) return;

  visualizerBinsListenPromise = listen<number[]>('audio:visualizer', (event) => {
    for (const listener of visualizerBinsListeners) {
      listener(event.payload);
    }
  })
    .then((unlisten) => {
      visualizerBinsUnlisten = unlisten;
      visualizerBinsListenPromise = null;

      // If everyone unsubscribed before Tauri finished wiring the callback, close it immediately.
      if (visualizerBinsListeners.size === 0 && visualizerBinsUnlisten) {
        visualizerBinsUnlisten();
        visualizerBinsUnlisten = null;
      }
    })
    .catch((error) => {
      visualizerBinsListenPromise = null;
      console.warn('[Visualizer] Failed to subscribe to audio:visualizer', error);
    });
}

function subscribeVisualizerBins(listener: VisualizerBinsListener) {
  visualizerBinsListeners.add(listener);
  ensureVisualizerBinsSubscription();

  return () => {
    visualizerBinsListeners.delete(listener);
    if (visualizerBinsListeners.size === 0 && visualizerBinsUnlisten) {
      visualizerBinsUnlisten();
      visualizerBinsUnlisten = null;
    }
  };
}

function hexToRgb(hex: string): RgbColor {
  const r = parseInt(hex.slice(1, 3), 16) || 255;
  const g = parseInt(hex.slice(3, 5), 16) || 255;
  const b = parseInt(hex.slice(5, 7), 16) || 255;
  return { r, g, b };
}

function mixRgb(from: RgbColor, to: RgbColor, factor: number): RgbColor {
  return {
    r: Math.round(from.r + (to.r - from.r) * factor),
    g: Math.round(from.g + (to.g - from.g) * factor),
    b: Math.round(from.b + (to.b - from.b) * factor),
  };
}

function toRgba(color: RgbColor, alpha: number) {
  return `rgba(${color.r},${color.g},${color.b},${alpha})`;
}

function luminance(color: RgbColor): number {
  return 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
}

function createThemeCanvasGradient(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  type: ThemeGradientType,
  angleDeg: number,
  stops: GradientStop[],
): CanvasGradient {
  const safeWidth = Math.max(width, 1);
  const safeHeight = Math.max(height, 1);

  if (type === 'radial') {
    const innerRadius = Math.max(6, Math.min(safeWidth, safeHeight) * 0.08);
    const outerRadius = Math.max(safeWidth, safeHeight) * 0.92;
    const gradient = ctx.createRadialGradient(
      x + safeWidth * 0.22,
      y + safeHeight * 0.2,
      innerRadius,
      x + safeWidth * 0.5,
      y + safeHeight * 0.52,
      outerRadius,
    );
    for (const stop of stops) {
      gradient.addColorStop(stop.offset, toRgba(stop.color, stop.alpha));
    }
    return gradient;
  }

  const angleRad = ((angleDeg - 90) * Math.PI) / 180;
  const cx = x + safeWidth / 2;
  const cy = y + safeHeight / 2;
  const radius = Math.hypot(safeWidth, safeHeight) / 2;
  const dx = Math.cos(angleRad) * radius;
  const dy = Math.sin(angleRad) * radius;
  const gradient = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
  for (const stop of stops) {
    gradient.addColorStop(stop.offset, toRgba(stop.color, stop.alpha));
  }
  return gradient;
}

export const Visualizer: React.FC<VisualizerProps> = ({ className = '', style }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const storeStyle = useSettingsStore((s) => s.visualizerStyle);
  const currentStyle = style || storeStyle || 'Off';
  const themeColorOpt = useSettingsStore((s) => s.visualizerThemeColor);
  const themePreset = useSettingsStore((s) => s.themePreset);
  const accentColorHex = useSettingsStore((s) => s.accentColor);
  const themeGradientEnabled = useSettingsStore((s) => s.themeGradientEnabled);
  const themeGradientFollowArtwork = useSettingsStore((s) => s.themeGradientFollowArtwork);
  const themeGradientType = useSettingsStore((s) => s.themeGradientType);
  const themeGradientColorA = useSettingsStore((s) => s.themeGradientColorA);
  const themeGradientColorB = useSettingsStore((s) => s.themeGradientColorB);
  const themeGradientColorC = useSettingsStore((s) => s.themeGradientColorC);
  const themeGradientAngle = useSettingsStore((s) => s.themeGradientAngle);
  const themeGlowEnabled = useSettingsStore((s) => s.themeGlowEnabled);
  const themeGlowIntensity = useSettingsStore((s) => s.themeGlowIntensity);
  const themeGlowOpacity = useSettingsStore((s) => s.themeGlowOpacity);
  const currentArtworkUrl = usePlayerStore((s) => s.currentTrack?.artwork_url ?? null);
  const vizScale = useSettingsStore((s) => s.visualizerScale) / 100;
  const vizYOffset = useSettingsStore((s) => s.visualizerYOffset);
  const vizMirror = useSettingsStore((s) => s.visualizerMirror);
  const vizSmoothing = useSettingsStore((s) => s.visualizerSmoothing);
  const vizBars = useSettingsStore((s) => s.visualizerBars);
  const targetFramerate = useSettingsStore((s) => s.targetFramerate);
  const unlockFramerate = useSettingsStore((s) => s.unlockFramerate);
  const artworkGradientPalette = useArtworkGradientPalette(
    themeGradientFollowArtwork ? currentArtworkUrl : null,
  );
  const gradientFromArtworkActive =
    themePreset === 'custom' &&
    themeGradientEnabled &&
    themeGradientFollowArtwork &&
    Boolean(artworkGradientPalette);
  const effectiveAccentColor = gradientFromArtworkActive
    ? artworkGradientPalette!.gradientB
    : accentColorHex;
  const effectiveThemeGradientColorA = gradientFromArtworkActive
    ? artworkGradientPalette!.gradientA
    : themeGradientColorA;
  const effectiveThemeGradientColorB = gradientFromArtworkActive
    ? artworkGradientPalette!.gradientB
    : themeGradientColorB;
  const effectiveThemeGradientColorC = gradientFromArtworkActive
    ? artworkGradientPalette!.gradientC
    : themeGradientColorC;

  const cfgRef = useRef({
    smoothing: vizSmoothing,
    mirror: vizMirror,
    bars: vizBars,
    accent: { r: 255, g: 255, b: 255 },
    highlight: { r: 255, g: 255, b: 255 },
    glow: { r: 255, g: 255, b: 255 },
    fade: { r: 255, g: 255, b: 255 },
    gradientActive: false,
    gradientType: 'linear' as ThemeGradientType,
    gradientAngle: 135,
    gradientA: { r: 255, g: 255, b: 255 },
    gradientB: { r: 255, g: 255, b: 255 },
    gradientC: { r: 255, g: 255, b: 255 },
    glowBlur: 0,
    glowAlpha: 0,
    frameBudgetMs: getAnimationFrameBudgetMs(targetFramerate, unlockFramerate),
  });

  useEffect(() => {
    const customGradientActive = themeColorOpt && themePreset === 'custom' && themeGradientEnabled;
    const accentRgb = themeColorOpt ? hexToRgb(effectiveAccentColor) : { r: 255, g: 255, b: 255 };
    const gradientColors = [
      effectiveThemeGradientColorA,
      effectiveThemeGradientColorB,
      effectiveThemeGradientColorC,
    ]
      .map(hexToRgb)
      .sort((lhs, rhs) => luminance(lhs) - luminance(rhs));
    const darkest = gradientColors[0];
    const middle = gradientColors[1];
    const brightest = gradientColors[2];
    const white = { r: 255, g: 255, b: 255 };
    const deepShade = { r: 10, g: 10, b: 14 };

    cfgRef.current.smoothing = vizSmoothing;
    cfgRef.current.mirror = vizMirror;
    cfgRef.current.bars = vizBars;
    cfgRef.current.accent = customGradientActive ? middle : accentRgb;
    cfgRef.current.highlight = customGradientActive
      ? brightest
      : mixRgb(accentRgb, white, themeColorOpt ? 0.18 : 0);
    cfgRef.current.glow = customGradientActive
      ? mixRgb(middle, brightest, 0.26)
      : mixRgb(accentRgb, white, themeColorOpt ? 0.08 : 0);
    cfgRef.current.fade = customGradientActive
      ? mixRgb(darkest, middle, 0.16)
      : mixRgb(accentRgb, deepShade, themeColorOpt ? 0.12 : 0);
    cfgRef.current.gradientActive = customGradientActive;
    cfgRef.current.gradientType = themeGradientType;
    cfgRef.current.gradientAngle = themeGradientAngle;
    cfgRef.current.gradientA = hexToRgb(effectiveThemeGradientColorA);
    cfgRef.current.gradientB = hexToRgb(effectiveThemeGradientColorB);
    cfgRef.current.gradientC = hexToRgb(effectiveThemeGradientColorC);
    cfgRef.current.glowBlur =
      themeColorOpt && themeGlowEnabled ? 10 + (themeGlowIntensity / 100) * 24 : 0;
    cfgRef.current.glowAlpha =
      themeColorOpt && themeGlowEnabled ? 0.1 + (themeGlowOpacity / 100) * 0.3 : 0;
    cfgRef.current.frameBudgetMs = getAnimationFrameBudgetMs(targetFramerate, unlockFramerate);
  }, [
    effectiveAccentColor,
    effectiveThemeGradientColorA,
    effectiveThemeGradientColorB,
    effectiveThemeGradientColorC,
    targetFramerate,
    themeColorOpt,
    themeGlowEnabled,
    themeGlowIntensity,
    themeGlowOpacity,
    themeGradientAngle,
    themeGradientEnabled,
    themeGradientFollowArtwork,
    themeGradientType,
    themePreset,
    unlockFramerate,
    vizBars,
    vizMirror,
    vizSmoothing,
  ]);

  useEffect(() => {
    if (currentStyle === 'Off') return;

    let isCancelled = false;
    let raf = 0;
    let ctx: CanvasRenderingContext2D | null = null;

    const targetBins = new Float32Array(128);
    const smoothBins = new Float32Array(128);
    let waveX = new Float32Array(0);
    let waveY = new Float32Array(0);
    let waveCap = 0;
    let lastFrameTs = 0;
    let smoothingAccumulatorMs = 0;
    let lastW = 0;
    let lastH = 0;
    const smoothingStepMs = 1000 / 60;

    const unsubscribeVisualizerBins = subscribeVisualizerBins((payload) => {
      if (isCancelled) return;
      const len = Math.min(payload.length, 64);
      for (let i = 0; i < len; i++) targetBins[i] = payload[i];
    });

    const draw = (ts: number) => {
      if (isAppBackgrounded()) {
        raf = requestAnimationFrame(draw);
        return;
      }

      const frameBudgetMs = cfgRef.current.frameBudgetMs;
      if (frameBudgetMs > 0 && ts - lastFrameTs < frameBudgetMs) {
        raf = requestAnimationFrame(draw);
        return;
      }

      const deltaMs =
        lastFrameTs > 0
          ? Math.min(Math.max(ts - lastFrameTs, 1000 / 240), 1000 / 8)
          : smoothingStepMs;
      lastFrameTs = ts;

      const canvas = canvasRef.current;
      if (!canvas) {
        raf = requestAnimationFrame(draw);
        return;
      }

      if (!ctx) ctx = canvas.getContext('2d', { alpha: true });
      if (!ctx) {
        raf = requestAnimationFrame(draw);
        return;
      }
      ctx.imageSmoothingEnabled = true;

      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const dpr = window.devicePixelRatio;

      if (lastW !== w || lastH !== h) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        lastW = w;
        lastH = h;
      } else {
        ctx.clearRect(0, 0, w, h);
      }

      const {
        smoothing,
        mirror,
        bars: numBars,
        accent,
        highlight,
        glow,
        fade,
        gradientActive,
        gradientType,
        gradientAngle,
        gradientA,
        gradientB,
        gradientC,
        glowBlur,
        glowAlpha,
      } = cfgRef.current;
      const lerp = Math.max(0.04, (100 - smoothing) / 100);

      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.globalCompositeOperation = 'source-over';

      smoothingAccumulatorMs = Math.min(smoothingAccumulatorMs + deltaMs, smoothingStepMs * 6);
      while (smoothingAccumulatorMs >= smoothingStepMs) {
        smoothingAccumulatorMs -= smoothingStepMs;

        for (let i = 0; i < numBars; i++) {
          const src = (i / numBars) * 64;
          const lo = src | 0;
          const hi = Math.min(lo + 1, 63);
          const f = src - lo;
          const raw = targetBins[lo] * (1 - f) + targetBins[hi] * f;
          const freqWeight = 0.4 + 0.6 * (i / Math.max(1, numBars - 1));
          const damped = raw * freqWeight;
          const target = (damped / 255) ** 0.7 * 255;
          smoothBins[i] += (target - smoothBins[i]) * lerp;
        }
      }

      if (mirror) {
        ctx.save();
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
      }

      if (currentStyle === 'Bars') {
        const barW = w / numBars;
        const gap = Math.max(1, barW * 0.15);
        const aW = barW - gap;
        const denseBars = numBars >= 56 || aW <= 6;
        const useRoundedBars = !denseBars && aW >= 7;
        const capHeight = denseBars ? 2 : 3;
        const barGradient = gradientActive
          ? createThemeCanvasGradient(ctx, 0, 0, w, h, gradientType, gradientAngle, [
              { offset: 0, color: gradientA, alpha: 0.74 },
              { offset: 0.5, color: gradientB, alpha: 0.9 },
              { offset: 1, color: gradientC, alpha: 1 },
            ])
          : (() => {
              const gradient = ctx.createLinearGradient(0, h, 0, 0);
              gradient.addColorStop(0, toRgba(accent, 0.76));
              gradient.addColorStop(0.72, toRgba(accent, 0.92));
              gradient.addColorStop(1, toRgba(highlight, 1));
              return gradient;
            })();

        ctx.shadowBlur = denseBars ? 0 : glowBlur * 0.4;
        ctx.shadowColor = toRgba(glow, glowAlpha * 0.56);
        for (let i = 0; i < numBars; i++) {
          const v = smoothBins[i];
          const bh = (v / 255) * h;
          const alpha = 0.16 + (v / 255) * 0.84;
          const x = i * barW;
          const y = h - bh;
          ctx.globalAlpha = alpha;
          ctx.fillStyle = barGradient;
          if (useRoundedBars) {
            ctx.beginPath();
            ctx.roundRect(x, y, aW, bh, [3, 3, 0, 0]);
            ctx.fill();
          } else {
            ctx.fillRect(x, y, aW, bh);
          }

          if (!denseBars && bh > 4) {
            ctx.globalAlpha = 0.34 + (v / 255) * 0.34;
            ctx.fillStyle = toRgba(highlight, 1);
            ctx.fillRect(x + 1, y, Math.max(1, aW - 2), Math.min(capHeight, bh));
          }
        }
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;
      } else if (currentStyle === 'Wave') {
        const n = numBars;
        const total = n + 2;
        if (total > waveCap) {
          waveCap = total;
          waveX = new Float32Array(waveCap);
          waveY = new Float32Array(waveCap);
        }
        const px = waveX;
        const py = waveY;
        for (let i = 0; i < n; i++) {
          px[i + 1] = (i / (n - 1)) * w;
          py[i + 1] = h - (smoothBins[i] / 255) * h;
        }
        px[0] = -px[1];
        py[0] = py[1];
        px[n + 1] = w + (w - px[n]);
        py[n + 1] = py[n];

        const tension = 0.35;
        let crestY = h;
        for (let i = 1; i <= n; i++) {
          crestY = Math.min(crestY, py[i]);
        }

        const context = ctx;
        const traceWave = (closeToBottom: boolean) => {
          context.beginPath();
          if (closeToBottom) {
            context.moveTo(0, h);
            context.lineTo(px[1], py[1]);
          } else {
            context.moveTo(px[1], py[1]);
          }

          for (let i = 1; i < total - 2; i++) {
            const cp1x = px[i] + (px[i + 1] - px[i - 1]) * tension;
            const cp1y = py[i] + (py[i + 1] - py[i - 1]) * tension;
            const cp2x = px[i + 1] - (px[i + 2] - px[i]) * tension;
            const cp2y = py[i + 1] - (py[i + 2] - py[i]) * tension;
            context.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, px[i + 1], py[i + 1]);
          }

          if (closeToBottom) {
            context.lineTo(w, h);
            context.closePath();
          }
        };

        const fillGradient = ctx.createLinearGradient(0, crestY, 0, h);
        if (gradientActive) {
          const themedFill = createThemeCanvasGradient(
            ctx,
            0,
            crestY,
            w,
            Math.max(h - crestY, 1),
            gradientType,
            gradientAngle,
            [
              { offset: 0, color: gradientC, alpha: 0.46 },
              { offset: 0.3, color: gradientB, alpha: 0.22 },
              { offset: 0.72, color: gradientA, alpha: 0.1 },
              { offset: 1, color: gradientA, alpha: 0.025 },
            ],
          );
          ctx.shadowBlur = glowBlur * 0.72;
          ctx.shadowColor = toRgba(glow, glowAlpha * 0.62);
          traceWave(true);
          ctx.fillStyle = themedFill;
          ctx.fill();
        } else {
          fillGradient.addColorStop(0, toRgba(highlight, 0.5));
          fillGradient.addColorStop(0.24, toRgba(glow, 0.22));
          fillGradient.addColorStop(0.62, toRgba(accent, 0.11));
          fillGradient.addColorStop(1, toRgba(fade, 0.025));

          ctx.shadowBlur = glowBlur * 0.72;
          ctx.shadowColor = toRgba(glow, glowAlpha * 0.62);
          traceWave(true);
          ctx.fillStyle = fillGradient;
          ctx.fill();
        }

        ctx.shadowBlur = glowBlur * 1.08;
        ctx.shadowColor = toRgba(glow, glowAlpha);
        ctx.lineWidth = Math.max(1.2, Math.min(2.8, h * 0.036));
        traceWave(false);
        ctx.strokeStyle = gradientActive
          ? createThemeCanvasGradient(ctx, 0, 0, w, h, gradientType, gradientAngle, [
              { offset: 0, color: gradientA, alpha: 0.92 },
              { offset: 0.5, color: gradientB, alpha: 0.96 },
              { offset: 1, color: gradientC, alpha: 0.92 },
            ])
          : toRgba(accent, 0.96);
        ctx.stroke();

        ctx.shadowBlur = 0;
        ctx.lineWidth = Math.max(0.55, Math.min(1.15, h * 0.014));
        traceWave(false);
        ctx.globalCompositeOperation = 'screen';
        ctx.strokeStyle = gradientActive
          ? createThemeCanvasGradient(ctx, 0, 0, w, h, gradientType, gradientAngle, [
              { offset: 0, color: gradientA, alpha: 0.44 },
              { offset: 0.5, color: gradientB, alpha: 0.72 },
              { offset: 1, color: gradientC, alpha: 0.58 },
            ])
          : toRgba(highlight, 0.78);
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
      } else if (currentStyle === 'Pulse') {
        const cx = w / 2;
        const cy = h / 2;
        let sum = 0;
        const bc = Math.max(1, numBars >> 2);
        for (let i = 0; i < bc; i++) sum += smoothBins[i];
        const avg = sum / bc;
        const rad = Math.min(w, h) * 0.2 + (avg / 255) * Math.min(w, h) * 0.3;

        const coreGradient = gradientActive
          ? createThemeCanvasGradient(
              ctx,
              cx - rad,
              cy - rad,
              rad * 2,
              rad * 2,
              'radial',
              gradientAngle,
              [
                { offset: 0, color: gradientB, alpha: 0.96 },
                { offset: 0.62, color: gradientC, alpha: 0.58 },
                { offset: 1, color: gradientA, alpha: 0 },
              ],
            )
          : (() => {
              const gradient = ctx.createRadialGradient(cx, cy, rad * 0.22, cx, cy, rad);
              gradient.addColorStop(0, toRgba(accent, 0.96));
              gradient.addColorStop(0.72, toRgba(highlight, 0.58));
              gradient.addColorStop(1, toRgba(fade, 0));
              return gradient;
            })();

        ctx.shadowBlur = glowBlur * 1.15;
        ctx.shadowColor = toRgba(glow, glowAlpha * 1.05);
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.fillStyle = coreGradient;
        ctx.fill();

        ctx.shadowColor = toRgba(glow, glowAlpha * 0.7);
        for (let ring = 1; ring <= 3; ring++) {
          const ringRadius = rad * (1 + ring * 0.18);
          ctx.beginPath();
          ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
          ctx.lineWidth = Math.max(1, 2.2 - ring * 0.35);
          ctx.shadowBlur = glowBlur * (0.85 + ring * 0.2);
          ctx.strokeStyle =
            ring === 1 ? toRgba(highlight, 0.24) : toRgba(glow, Math.max(0.08, 0.18 - ring * 0.04));
          ctx.stroke();
        }

        ctx.shadowBlur = 0;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(3, rad * 0.12), 0, Math.PI * 2);
        ctx.fillStyle = toRgba(highlight, 0.82);
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      if (mirror) ctx.restore();
      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => {
      isCancelled = true;
      unsubscribeVisualizerBins();
      cancelAnimationFrame(raf);
    };
  }, [currentStyle]);

  if (currentStyle === 'Off') return null;

  return (
    <canvas
      ref={canvasRef}
      className={`pointer-events-none ${className}`}
      style={{
        transform: `translate(0px, ${vizYOffset}px) scale(${vizScale})`,
        transformOrigin: 'bottom center',
        transition: 'transform 0.15s ease-out',
      }}
    />
  );
};
