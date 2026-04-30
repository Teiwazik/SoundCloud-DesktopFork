import React, { useEffect, useMemo, useRef } from 'react';
import { subscribeVisualizerBins } from '../Visualizer';

interface Props {
  /** Number of drifting accent particles. Fewer on smaller blocks. */
  particleCount?: number;
  /** Max blur radius for aurora orbs. Lower = cheaper GPU paint. */
  blur?: number;
  /** Primary aurora opacity. */
  intensity?: number;
  /** When true, the two aurora orbs pulse with the audio level — bass-heavy
   *  bins drive scale + opacity through CSS variables (no React re-renders).
   *  Falls back to the static `intensity` when no audio is playing. */
  reactive?: boolean;
}

/**
 * Decorative aurora + particle layer for SoundWave blocks.
 * Pure CSS animations, `contain: strict` isolates repaints, no React updates
 * during animation.
 */
export const AmbientLayer = React.memo(function AmbientLayer({
  particleCount = 12,
  blur = 45,
  intensity = 0.55,
  reactive = false,
}: Props) {
  const particles = useMemo(
    () => Array.from({ length: particleCount }, (_, i) => i),
    [particleCount],
  );

  // Refs to the two aurora orbs — we mutate inline opacity/transform every
  // animation frame from a smoothed audio level, bypassing React re-renders.
  const auroraARef = useRef<HTMLDivElement>(null);
  const auroraBRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!reactive) return;
    let smoothedLevel = 0;
    let lastBins: number[] | null = null;
    let rafId = 0;
    let mounted = true;

    const unsubscribe = subscribeVisualizerBins((bins) => {
      lastBins = bins;
    });

    const tick = () => {
      if (!mounted) return;
      // Compute a bass-weighted level. The first ~12% of bins covers the
      // sub/low end which carries the perceptual "punch" — driving the glow
      // off the full spectrum makes it feel mushy.
      let target = 0;
      if (lastBins && lastBins.length > 0) {
        const bassEnd = Math.max(4, Math.floor(lastBins.length * 0.12));
        let sum = 0;
        for (let i = 0; i < bassEnd; i++) sum += lastBins[i];
        // bins are ~0..255 (byte-frequency); normalize to 0..1.
        target = Math.min(1, sum / bassEnd / 255);
      }
      // Critically-damped exponential smoothing: ~80ms attack, ~250ms release.
      const attack = target > smoothedLevel ? 0.22 : 0.06;
      smoothedLevel += (target - smoothedLevel) * attack;

      // Map smoothed level to opacity boost (0..+0.6) and a subtle scale
      // pulse (1.0..1.08). Scale via transform is cheap on already-blurred
      // elements (composite-only). Opacity multiplies the static intensity.
      const opacityBoost = smoothedLevel * 0.6;
      const scale = 1 + smoothedLevel * 0.08;
      const elA = auroraARef.current;
      const elB = auroraBRef.current;
      if (elA) {
        elA.style.opacity = String(Math.min(1, intensity + opacityBoost));
        elA.style.setProperty('--sw-pulse-scale', String(scale));
      }
      if (elB) {
        elB.style.opacity = String(Math.min(1, intensity * 0.9 + opacityBoost * 0.7));
        elB.style.setProperty('--sw-pulse-scale', String(1 + smoothedLevel * 0.05));
      }

      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    return () => {
      mounted = false;
      cancelAnimationFrame(rafId);
      unsubscribe();
    };
  }, [reactive, intensity]);

  return (
    <div
      className="absolute inset-0 pointer-events-none overflow-hidden"
      aria-hidden
      style={{ contain: 'strict', transform: 'translateZ(0)' }}
    >
      {/* Outer wrapper runs the CSS drift animation (`transform: translate`).
          Inner child applies the music-driven `scale(...)` — separating them
          prevents the inline transform from clobbering the keyframe.
          Position mirrors the right orb (-top-1/4, off-edge by 12%, 50/160
          %) so both glow blobs are equally visible — previously left orb
          was centered well off-canvas and showed only its right half. */}
      <div
        className="absolute top-0 -left-[25%] w-[60%] h-full"
        style={{
          animation: 'sw-aurora 32s linear infinite',
          willChange: 'transform',
        }}
      >
        <div
          ref={auroraARef}
          className="absolute inset-0 rounded-full"
          style={{
            background: 'radial-gradient(closest-side, var(--color-accent-glow), transparent 70%)',
            filter: `blur(${blur}px)`,
            opacity: intensity,
            transform: 'scale(var(--sw-pulse-scale, 1))',
            transformOrigin: 'center',
            transition: 'transform 60ms linear',
            willChange: 'transform, opacity',
          }}
        />
      </div>
      {/* Right orb: previously bottom-right and white-7% — invisible at the
          top of the block where the user looks. Moved to top-right and
          re-tinted with the accent glow so the music-reactive pulse is
          visible across the full width of the block, not just the left. */}
      <div
        className="absolute top-0 -right-[25%] w-[60%] h-full"
        style={{
          animation: 'sw-aurora 44s linear reverse infinite',
          willChange: 'transform',
        }}
      >
        <div
          ref={auroraBRef}
          className="absolute inset-0 rounded-full"
          style={{
            background: 'radial-gradient(closest-side, var(--color-accent-glow), transparent 70%)',
            filter: `blur(${blur + 5}px)`,
            opacity: intensity * 0.7,
            transform: 'scale(var(--sw-pulse-scale, 1))',
            transformOrigin: 'center',
            transition: 'transform 60ms linear',
            willChange: 'transform, opacity',
          }}
        />
      </div>

      {particles.map((i) => {
        const size = 2 + (i % 3);
        const left = (i * 41) % 100;
        const top = 12 + ((i * 53) % 70);
        const duration = 5200 + ((i * 313) % 3200);
        const delay = (i * 277) % 3800;
        return (
          <span
            key={i}
            className="absolute rounded-full"
            style={{
              width: `${size}px`,
              height: `${size}px`,
              left: `${left}%`,
              top: `${top}%`,
              background: 'var(--color-accent)',
              boxShadow: '0 0 6px var(--color-accent-glow)',
              animation: `sw-drift ${duration}ms ease-in-out ${delay}ms infinite`,
            }}
          />
        );
      })}
    </div>
  );
});
