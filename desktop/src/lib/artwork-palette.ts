import { useEffect, useRef, useState } from 'react';
import { art } from './formatters';

export type ArtworkColorTuple = [number, number, number];

export interface ArtworkGradientPalette {
  accent: ArtworkColorTuple;
  gradientA: string;
  gradientB: string;
  gradientC: string;
}

type HslTuple = [number, number, number];

type PaletteBucket = {
  r: number;
  g: number;
  b: number;
  weight: number;
  count: number;
  luminance: number;
  saturation: number;
};

type PaletteSwatch = {
  color: ArtworkColorTuple;
  weight: number;
  luminance: number;
  saturation: number;
};

const FALLBACK_ARTWORK_PALETTE: ArtworkGradientPalette = {
  accent: [255, 85, 0],
  gradientA: '#0b1220',
  gradientB: '#ff5500',
  gradientC: '#402014',
};

const artworkPaletteCache = new Map<string, ArtworkGradientPalette>();
const artworkPalettePromises = new Map<string, Promise<ArtworkGradientPalette>>();

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function rgbToHex([r, g, b]: ArtworkColorTuple): string {
  return `#${[r, g, b]
    .map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0'))
    .join('')}`;
}

function rgbToHsl([r, g, b]: ArtworkColorTuple): HslTuple {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  const lightness = (max + min) / 2;

  if (delta === 0) {
    return [0, 0, lightness];
  }

  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);

  let hue = 0;
  switch (max) {
    case red:
      hue = (green - blue) / delta + (green < blue ? 6 : 0);
      break;
    case green:
      hue = (blue - red) / delta + 2;
      break;
    default:
      hue = (red - green) / delta + 4;
      break;
  }

  return [(hue * 60) % 360, saturation, lightness];
}

function hueToRgb(p: number, q: number, t: number): number {
  let next = t;
  if (next < 0) next += 1;
  if (next > 1) next -= 1;
  if (next < 1 / 6) return p + (q - p) * 6 * next;
  if (next < 1 / 2) return q;
  if (next < 2 / 3) return p + (q - p) * (2 / 3 - next) * 6;
  return p;
}

function hslToRgb([h, s, l]: HslTuple): ArtworkColorTuple {
  const hue = (((h % 360) + 360) % 360) / 360;
  const saturation = clamp(s, 0, 1);
  const lightness = clamp(l, 0, 1);

  if (saturation === 0) {
    const gray = Math.round(lightness * 255);
    return [gray, gray, gray];
  }

  const q =
    lightness < 0.5
      ? lightness * (1 + saturation)
      : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;

  return [
    Math.round(hueToRgb(p, q, hue + 1 / 3) * 255),
    Math.round(hueToRgb(p, q, hue) * 255),
    Math.round(hueToRgb(p, q, hue - 1 / 3) * 255),
  ];
}

function mixHue(from: number, to: number, amount: number): number {
  const delta = ((((to - from) % 360) + 540) % 360) - 180;
  return (from + delta * clamp(amount, 0, 1) + 360) % 360;
}

function colorDistance(from: ArtworkColorTuple, to: ArtworkColorTuple): number {
  const dr = from[0] - to[0];
  const dg = from[1] - to[1];
  const db = from[2] - to[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function scorePixel(r: number, g: number, b: number): number {
  const [, saturation, lightness] = rgbToHsl([r, g, b]);
  const tonalFocus = 1 - Math.min(1, Math.abs(lightness - 0.46) / 0.46);
  const vibrance = saturation < 0.04 ? saturation * 4 : saturation;
  return 0.2 + vibrance * 1.4 + tonalFocus * 0.55;
}

function buildPaletteFromPixels(data: Uint8ClampedArray): ArtworkGradientPalette {
  const buckets = new Map<string, PaletteBucket>();

  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha < 72) continue;

    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const key = `${Math.round(r / 32)}:${Math.round(g / 32)}:${Math.round(b / 32)}`;
    const weight = scorePixel(r, g, b);
    const [, saturation, lightness] = rgbToHsl([r, g, b]);
    const bucket = buckets.get(key);

    if (bucket) {
      bucket.r += r * weight;
      bucket.g += g * weight;
      bucket.b += b * weight;
      bucket.weight += weight;
      bucket.count += 1;
      bucket.luminance += lightness * weight;
      bucket.saturation += saturation * weight;
      continue;
    }

    buckets.set(key, {
      r: r * weight,
      g: g * weight,
      b: b * weight,
      weight,
      count: 1,
      luminance: lightness * weight,
      saturation: saturation * weight,
    });
  }

  const swatches = Array.from(buckets.values())
    .filter((bucket) => bucket.weight > 0)
    .map<PaletteSwatch>((bucket) => ({
      color: [
        Math.round(bucket.r / bucket.weight),
        Math.round(bucket.g / bucket.weight),
        Math.round(bucket.b / bucket.weight),
      ],
      weight: bucket.weight,
      luminance: bucket.luminance / bucket.weight,
      saturation: bucket.saturation / bucket.weight,
    }))
    .sort((left, right) => right.weight - left.weight);

  if (swatches.length === 0) {
    return FALLBACK_ARTWORK_PALETTE;
  }

  const primary =
    swatches.find(
      (swatch) => swatch.saturation > 0.08 && swatch.luminance > 0.14 && swatch.luminance < 0.78,
    ) ?? swatches[0];
  const secondary =
    swatches
      .filter((swatch) => swatch !== primary)
      .sort((left, right) => {
        const leftScore =
          left.weight * 0.72 +
          colorDistance(primary.color, left.color) * 0.45 +
          left.saturation * 72;
        const rightScore =
          right.weight * 0.72 +
          colorDistance(primary.color, right.color) * 0.45 +
          right.saturation * 72;
        return rightScore - leftScore;
      })[0] ?? primary;
  const tertiary =
    swatches
      .filter((swatch) => swatch !== primary && swatch !== secondary)
      .sort((left, right) => {
        const leftDistance = Math.min(
          colorDistance(primary.color, left.color),
          colorDistance(secondary.color, left.color),
        );
        const rightDistance = Math.min(
          colorDistance(primary.color, right.color),
          colorDistance(secondary.color, right.color),
        );
        const leftScore = left.weight * 0.54 + leftDistance * 0.56 + left.luminance * 44;
        const rightScore = right.weight * 0.54 + rightDistance * 0.56 + right.luminance * 44;
        return rightScore - leftScore;
      })[0] ?? secondary;

  const primaryHsl = rgbToHsl(primary.color);
  const secondaryHsl = rgbToHsl(secondary.color);
  const tertiaryHsl = rgbToHsl(tertiary.color);

  const accentHue = primaryHsl[0];
  const accentSaturation = clamp(
    Math.max(primaryHsl[1], secondaryHsl[1] * 0.9) * 1.08 + 0.04,
    0.28,
    0.92,
  );
  const accentLightness = clamp(primaryHsl[2] * 0.88 + 0.04, 0.24, 0.58);

  const gradientA = hslToRgb([
    mixHue(accentHue, secondaryHsl[0], 0.34),
    clamp(Math.max(primaryHsl[1] * 0.72, secondaryHsl[1] * 0.78) + 0.02, 0.18, 0.68),
    clamp(Math.min(primaryHsl[2], secondaryHsl[2]) * 0.44, 0.08, 0.22),
  ]);
  const accent = hslToRgb([accentHue, accentSaturation, accentLightness]);
  const gradientC = hslToRgb([
    mixHue(accentHue, tertiaryHsl[0], 0.18),
    clamp(Math.max(primaryHsl[1], tertiaryHsl[1]) * 0.9 + 0.08, 0.28, 0.96),
    clamp(Math.max(primaryHsl[2], tertiaryHsl[2]) * 0.86 + 0.12, 0.28, 0.64),
  ]);

  return {
    accent,
    gradientA: rgbToHex(gradientA),
    gradientB: rgbToHex(accent),
    gradientC: rgbToHex(gradientC),
  };
}

export function extractArtworkGradientPalette(src: string): Promise<ArtworkGradientPalette> {
  const cached = artworkPaletteCache.get(src);
  if (cached) return Promise.resolve(cached);

  const pending = artworkPalettePromises.get(src);
  if (pending) return pending;

  const nextPromise = new Promise<ArtworkGradientPalette>((resolve) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 24;
        canvas.height = 24;
        const ctx = canvas.getContext('2d');

        if (!ctx) {
          resolve(FALLBACK_ARTWORK_PALETTE);
          return;
        }

        ctx.drawImage(image, 0, 0, 24, 24);
        const palette = buildPaletteFromPixels(ctx.getImageData(0, 0, 24, 24).data);
        artworkPaletteCache.set(src, palette);
        resolve(palette);
      } catch {
        resolve(FALLBACK_ARTWORK_PALETTE);
      }
    };
    image.onerror = () => resolve(FALLBACK_ARTWORK_PALETTE);
    image.src = src;
  }).finally(() => {
    artworkPalettePromises.delete(src);
  });

  artworkPalettePromises.set(src, nextPromise);
  return nextPromise;
}

export function useArtworkGradientPalette(artworkUrl: string | null | undefined) {
  const [palette, setPalette] = useState<ArtworkGradientPalette | null>(null);
  const previousSrcRef = useRef<string | null>(null);

  useEffect(() => {
    const src = art(artworkUrl ?? null, 't200x200');
    if (!src) {
      previousSrcRef.current = null;
      setPalette(null);
      return;
    }

    if (src === previousSrcRef.current) return;
    previousSrcRef.current = src;

    const cached = artworkPaletteCache.get(src);
    if (cached) {
      setPalette(cached);
      return;
    }

    setPalette(null);

    let cancelled = false;
    extractArtworkGradientPalette(src).then((nextPalette) => {
      if (!cancelled) {
        setPalette(nextPalette);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [artworkUrl]);

  return palette;
}

export function getFallbackArtworkGradientPalette(): ArtworkGradientPalette {
  return FALLBACK_ARTWORK_PALETTE;
}
