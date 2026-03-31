import { listen } from '@tauri-apps/api/event';
import type React from 'react';
import { useEffect, useRef } from 'react';
import { useSettingsStore } from '../../stores/settings';

export type VisualizerStyle = 'Off' | 'Bars' | 'Wave' | 'Pulse';

interface VisualizerProps {
  className?: string;
  style?: VisualizerStyle;
}

function hexToRgb(hex: string) {
  const r = parseInt(hex.slice(1, 3), 16) || 255;
  const g = parseInt(hex.slice(3, 5), 16) || 255;
  const b = parseInt(hex.slice(5, 7), 16) || 255;
  return { r, g, b };
}

export const Visualizer: React.FC<VisualizerProps> = ({ className = '', style }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const storeStyle = useSettingsStore((s) => s.visualizerStyle);
  const currentStyle = style || storeStyle || 'Off';
  const themeColorOpt = useSettingsStore((s) => s.visualizerThemeColor);
  const accentColorHex = useSettingsStore((s) => s.accentColor);
  const vizScale = useSettingsStore((s) => s.visualizerScale) / 100;
  const vizXOffset = useSettingsStore((s) => s.visualizerXOffset);
  const vizYOffset = useSettingsStore((s) => s.visualizerYOffset);
  const vizMirror = useSettingsStore((s) => s.visualizerMirror);
  const vizSmoothing = useSettingsStore((s) => s.visualizerSmoothing);
  const vizBars = useSettingsStore((s) => s.visualizerBars);

  // Refs for hot-loop values (avoid re-creating effect)
  const cfgRef = useRef({
    smoothing: vizSmoothing,
    mirror: vizMirror,
    bars: vizBars,
    rgb: { r: 255, g: 255, b: 255 },
  });
  useEffect(() => {
    cfgRef.current.smoothing = vizSmoothing;
    cfgRef.current.mirror = vizMirror;
    cfgRef.current.bars = vizBars;
    cfgRef.current.rgb = themeColorOpt ? hexToRgb(accentColorHex) : { r: 255, g: 255, b: 255 };
  }, [vizSmoothing, vizMirror, vizBars, themeColorOpt, accentColorHex]);

  useEffect(() => {
    if (currentStyle === 'Off') return;

    let isCancelled = false;
    let unlisten: (() => void) | null = null;
    let raf = 0;
    let ctx: CanvasRenderingContext2D | null = null;
    // Single shared typed array for target bins — avoids GC churn
    const targetBins = new Float32Array(128);
    const smoothBins = new Float32Array(128);
    let waveX = new Float32Array(0);
    let waveY = new Float32Array(0);
    let waveCap = 0;
    let lastFrameTs = 0;
    const frameBudgetMs = 1000 / 30;
    let lastW = 0,
      lastH = 0;

    const setup = async () => {
      const fn = await listen<number[]>('audio:visualizer', (ev) => {
        if (isCancelled) return;
        const d = ev.payload;
        const len = Math.min(d.length, 64);
        for (let i = 0; i < len; i++) targetBins[i] = d[i];
      });
      if (isCancelled) {
        fn(); // Unsubscribe immediately if unmounted during await
      } else {
        unlisten = fn;
      }
    };
    setup();

    const draw = (ts: number) => {
      if (document.visibilityState === 'hidden') {
        raf = requestAnimationFrame(draw);
        return;
      }

      if (ts - lastFrameTs < frameBudgetMs) {
        raf = requestAnimationFrame(draw);
        return;
      }
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

      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const dpr = window.devicePixelRatio;

      // Resize only when dimensions actually change
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
        rgb: { r, g, b },
      } = cfgRef.current;
      // Higher smoothing value should produce smoother (slower) bar motion.
      const lerp = Math.max(0.04, (100 - smoothing) / 100);

      // Resample 64 → numBars with lerp smoothing
      // Apply power-curve to tame bass dominance (lower bins are much louder raw)
      for (let i = 0; i < numBars; i++) {
        const src = (i / numBars) * 64;
        const lo = src | 0; // fast floor
        const hi = Math.min(lo + 1, 63);
        const f = src - lo;
        const raw = targetBins[lo] * (1 - f) + targetBins[hi] * f;
        // Tame bass (lower indices) by applying a frequency-dependent weight
        // e.g. lower bins get multiplied by ~0.4, higher bins approach 1.0
        const freqWeight = 0.4 + 0.6 * (i / Math.max(1, numBars - 1));
        const damped = raw * freqWeight;
        // Exponential curve to boost the perceived quiet parts slightly
        const target = (damped / 255) ** 0.7 * 255;
        smoothBins[i] += (target - smoothBins[i]) * lerp;
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
        // Use a fixed opacity per bar so left/right symmetry is preserved
        for (let i = 0; i < numBars; i++) {
          const v = smoothBins[i];
          const bh = (v / 255) * h;
          // Opacity based on energy but symmetric: use the normalised height
          const alpha = Math.max(0.05, (v / 255) * 0.85);
          ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
          ctx.beginPath();
          ctx.roundRect(i * barW, h - bh, aW, bh, [3, 3, 0, 0]);
          ctx.fill();
        }
      } else if (currentStyle === 'Wave') {
        // Build Catmull-Rom point array with virtual edge clamping
        const n = numBars;
        // Reuse a flat array: [x0,y0, x1,y1, ...] — (n+2) points including virtual edges
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
        // Virtual endpoints for edge smoothness
        px[0] = -px[1];
        py[0] = py[1];
        px[n + 1] = w + (w - px[n]);
        py[n + 1] = py[n];

        const tension = 0.35;
        ctx.beginPath();
        ctx.moveTo(0, h);
        ctx.lineTo(px[1], py[1]);

        for (let i = 1; i < total - 2; i++) {
          const cp1x = px[i] + (px[i + 1] - px[i - 1]) * tension;
          const cp1y = py[i] + (py[i + 1] - py[i - 1]) * tension;
          const cp2x = px[i + 1] - (px[i + 2] - px[i]) * tension;
          const cp2y = py[i + 1] - (py[i + 2] - py[i]) * tension;
          ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, px[i + 1], py[i + 1]);
        }

        ctx.lineTo(w, h);
        ctx.closePath();

        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, `rgba(${r},${g},${b},0.45)`);
        grad.addColorStop(0.6, `rgba(${r},${g},${b},0.15)`);
        grad.addColorStop(1, `rgba(${r},${g},${b},0.0)`);
        ctx.fillStyle = grad;
        ctx.fill();
        // No bottom stroke — fill only for clean look
      } else if (currentStyle === 'Pulse') {
        const cx = w / 2,
          cy = h / 2;
        let sum = 0;
        const bc = Math.max(1, numBars >> 2);
        for (let i = 0; i < bc; i++) sum += smoothBins[i];
        const avg = sum / bc;
        const rad = Math.min(w, h) * 0.2 + (avg / 255) * Math.min(w, h) * 0.3;
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        const grad = ctx.createRadialGradient(cx, cy, rad * 0.5, cx, cy, rad * 1.5);
        grad.addColorStop(0, `rgba(${r},${g},${b},0.8)`);
        grad.addColorStop(1, `rgba(${r},${g},${b},0.0)`);
        ctx.fillStyle = grad;
        ctx.fill();
      }

      if (mirror) ctx.restore();
      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => {
      isCancelled = true;
      if (unlisten) unlisten();
      cancelAnimationFrame(raf);
    };
  }, [currentStyle]);

  if (currentStyle === 'Off') return null;

  return (
    <canvas
      ref={canvasRef}
      className={`pointer-events-none ${className}`}
      style={{
        transform: `translate(${vizXOffset}px, ${vizYOffset}px) scale(${vizScale})`,
        transformOrigin: 'bottom center',
        transition: 'transform 0.15s ease-out',
      }}
    />
  );
};
