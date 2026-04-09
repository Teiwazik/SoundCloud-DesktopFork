import { useEffect } from 'react';
import { useArtworkGradientPalette } from '../lib/artwork-palette';
import { usePlayerStore } from '../stores/player';
import { useSettingsStore } from '../stores/settings';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeHex(hex: string): string {
  const value = hex.trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    const [, r, g, b] = value;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return '#ffffff';
}

function hexToRgbTuple(hex: string): [number, number, number] {
  const normalized = normalizeHex(hex);
  const r = Number.parseInt(normalized.slice(1, 3), 16);
  const g = Number.parseInt(normalized.slice(3, 5), 16);
  const b = Number.parseInt(normalized.slice(5, 7), 16);
  return [r, g, b];
}

function hexToRgb(hex: string): string {
  return hexToRgbTuple(hex).join(', ');
}

function hexToRgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgbTuple(hex);
  return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1)})`;
}

function rgbTupleToHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b]
    .map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0'))
    .join('')}`;
}

function mixHex(from: string, to: string, amount: number): string {
  const [fromR, fromG, fromB] = hexToRgbTuple(from);
  const [toR, toG, toB] = hexToRgbTuple(to);
  const mix = (left: number, right: number) => left + (right - left) * clamp(amount, 0, 1);
  return rgbTupleToHex([mix(fromR, toR), mix(fromG, toG), mix(fromB, toB)]);
}

const TRANSPARENT_LAYER = 'linear-gradient(180deg, rgba(0, 0, 0, 0), rgba(0, 0, 0, 0))';
const TRANSPARENT_STACK = `${TRANSPARENT_LAYER}, ${TRANSPARENT_LAYER}, ${TRANSPARENT_LAYER}`;

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const themePreset = useSettingsStore((s) => s.themePreset);
  const accentColor = useSettingsStore((s) => s.accentColor);
  const bgPrimary = useSettingsStore((s) => s.bgPrimary);
  const glassBlur = useSettingsStore((s) => s.glassBlur);
  const themeGradientEnabled = useSettingsStore((s) => s.themeGradientEnabled);
  const themeGradientFollowArtwork = useSettingsStore((s) => s.themeGradientFollowArtwork);
  const themeGradientType = useSettingsStore((s) => s.themeGradientType);
  const themeGradientColorA = useSettingsStore((s) => s.themeGradientColorA);
  const themeGradientColorB = useSettingsStore((s) => s.themeGradientColorB);
  const themeGradientColorC = useSettingsStore((s) => s.themeGradientColorC);
  const themeGradientAngle = useSettingsStore((s) => s.themeGradientAngle);
  const themeGradientAnimated = useSettingsStore((s) => s.themeGradientAnimated);
  const themeGradientAnimation = useSettingsStore((s) => s.themeGradientAnimation);
  const themeGradientSpeed = useSettingsStore((s) => s.themeGradientSpeed);
  const themeGlowEnabled = useSettingsStore((s) => s.themeGlowEnabled);
  const themeGlowIntensity = useSettingsStore((s) => s.themeGlowIntensity);
  const themeGlowOpacity = useSettingsStore((s) => s.themeGlowOpacity);
  const lowPerformanceMode = useSettingsStore((s) => s.lowPerformanceMode);
  const currentArtworkUrl = usePlayerStore((s) => s.currentTrack?.artwork_url ?? null);
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
    : accentColor;
  const effectiveThemeGradientColorA = gradientFromArtworkActive
    ? artworkGradientPalette!.gradientA
    : themeGradientColorA;
  const effectiveThemeGradientColorB = gradientFromArtworkActive
    ? artworkGradientPalette!.gradientB
    : themeGradientColorB;
  const effectiveThemeGradientColorC = gradientFromArtworkActive
    ? artworkGradientPalette!.gradientC
    : themeGradientColorC;

  useEffect(() => {
    const root = document.documentElement;
    const rgb = hexToRgb(effectiveAccentColor);
    const [r, g, b] = hexToRgbTuple(effectiveAccentColor);
    const bgRgb = hexToRgb(bgPrimary);
    const hover = `rgb(${Math.min(255, r + 26)}, ${Math.min(255, g + 26)}, ${Math.min(255, b + 26)})`;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const isCustomTheme = themePreset === 'custom';
    const gradientActive = isCustomTheme && themeGradientEnabled;
    const glowActive = isCustomTheme && themeGlowEnabled;
    const animateGradient = gradientActive && themeGradientAnimated && !lowPerformanceMode;
    const glowStrength = glowActive ? clamp(themeGlowIntensity / 100, 0, 1) : 0;
    const glowAlpha = glowActive ? clamp(themeGlowOpacity / 100, 0, 1) : 0;

    const accentGlow = glowActive
      ? `rgba(${rgb}, ${0.08 + glowAlpha * 0.32})`
      : isCustomTheme
        ? `rgba(${rgb}, 0)`
        : `rgba(${rgb}, 0.2)`;
    const selection = glowActive ? `rgba(${rgb}, ${0.18 + glowAlpha * 0.34})` : `rgba(${rgb}, 0.3)`;
    const surfaceAccentColor = isCustomTheme
      ? mixHex(
          effectiveAccentColor,
          bgPrimary,
          gradientFromArtworkActive ? 0.62 : gradientActive ? 0.46 : 0.4,
        )
      : mixHex(effectiveAccentColor, bgPrimary, 0.54);
    const surfaceGradientA = gradientActive
      ? mixHex(effectiveThemeGradientColorA, bgPrimary, gradientFromArtworkActive ? 0.52 : 0.38)
      : surfaceAccentColor;
    const surfaceGradientB = gradientActive
      ? mixHex(effectiveThemeGradientColorB, bgPrimary, gradientFromArtworkActive ? 0.64 : 0.48)
      : surfaceAccentColor;
    const surfaceGradientC = gradientActive
      ? mixHex(effectiveThemeGradientColorC, bgPrimary, gradientFromArtworkActive ? 0.58 : 0.42)
      : surfaceAccentColor;

    const accentGradient = gradientActive
      ? themeGradientType === 'radial'
        ? `radial-gradient(circle at 18% 18%, ${effectiveThemeGradientColorA} 0%, ${effectiveThemeGradientColorB} 48%, ${effectiveThemeGradientColorC} 100%)`
        : `linear-gradient(${themeGradientAngle}deg, ${effectiveThemeGradientColorA} 0%, ${effectiveThemeGradientColorB} 50%, ${effectiveThemeGradientColorC} 100%)`
      : `linear-gradient(135deg, ${effectiveAccentColor} 0%, ${hover} 100%)`;
    const accentGradientHover = gradientActive
      ? themeGradientType === 'radial'
        ? `radial-gradient(circle at 76% 20%, ${effectiveThemeGradientColorB} 0%, ${effectiveThemeGradientColorC} 52%, ${effectiveThemeGradientColorA} 100%)`
        : `linear-gradient(${(themeGradientAngle + 24) % 360}deg, ${effectiveThemeGradientColorB} 0%, ${effectiveThemeGradientColorC} 52%, ${effectiveThemeGradientColorA} 100%)`
      : `linear-gradient(135deg, ${hover} 0%, ${effectiveAccentColor} 100%)`;
    const accentGradientSoft = gradientActive
      ? themeGradientType === 'radial'
        ? `radial-gradient(circle at 20% 20%, ${hexToRgba(surfaceGradientA, gradientFromArtworkActive ? 0.16 : 0.18)} 0%, ${hexToRgba(surfaceGradientB, gradientFromArtworkActive ? 0.1 : 0.12)} 48%, ${hexToRgba(surfaceGradientC, gradientFromArtworkActive ? 0.07 : 0.08)} 100%)`
        : `linear-gradient(${themeGradientAngle}deg, ${hexToRgba(surfaceGradientA, gradientFromArtworkActive ? 0.16 : 0.18)} 0%, ${hexToRgba(surfaceGradientB, gradientFromArtworkActive ? 0.11 : 0.13)} 50%, ${hexToRgba(surfaceGradientC, gradientFromArtworkActive ? 0.08 : 0.09)} 100%)`
      : `linear-gradient(135deg, ${hexToRgba(surfaceAccentColor, 0.16)} 0%, ${hexToRgba(surfaceAccentColor, 0.07)} 100%)`;
    const accentGradientSize = animateGradient ? '180% 180%' : '100% 100%';
    const accentGlowShadow = glowActive
      ? `0 0 ${Math.round(16 + glowStrength * 20)}px ${hexToRgba(effectiveAccentColor, 0.16 + glowAlpha * 0.2)}`
      : `0 0 0 rgba(${rgb}, 0)`;
    const accentGlowStrong = glowActive
      ? `0 0 ${Math.round(24 + glowStrength * 30)}px ${hexToRgba(effectiveAccentColor, 0.2 + glowAlpha * 0.26)}`
      : accentGlowShadow;
    const accentSoftBorder = gradientActive
      ? hexToRgba(
          gradientFromArtworkActive ? surfaceGradientB : effectiveThemeGradientColorB,
          gradientFromArtworkActive ? 0.14 : 0.18,
        )
      : hexToRgba(surfaceAccentColor, 0.16);
    const accentGlassTint = gradientActive
      ? gradientFromArtworkActive
        ? surfaceGradientB
        : surfaceGradientB
      : surfaceAccentColor;
    const baseGlassTint = isCustomTheme
      ? 0.026 + (gradientActive ? 0.014 : 0) + glowAlpha * 0.05
      : 0.02;
    const glassTint = gradientFromArtworkActive
      ? baseGlassTint * 0.66
      : gradientActive
        ? baseGlassTint * 0.82
        : baseGlassTint;
    const glassHoverTint = gradientFromArtworkActive
      ? glassTint + 0.024
      : gradientActive
        ? glassTint + 0.028
        : isCustomTheme
          ? glassTint + 0.04
          : 0.05;
    const glassSaturate = gradientFromArtworkActive
      ? 1.04 + glowAlpha * 0.12
      : gradientActive
        ? 1.16 + glowAlpha * 0.14
        : isCustomTheme
          ? 1.28 + glowAlpha * 0.16
          : 1.42;
    const glassFeaturedSaturate = gradientFromArtworkActive
      ? 1.1 + glowAlpha * 0.14
      : gradientActive
        ? 1.24 + glowAlpha * 0.16
        : isCustomTheme
          ? 1.36 + glowAlpha * 0.18
          : 1.55;
    const glassBorder = isCustomTheme
      ? hexToRgba(surfaceAccentColor, 0.06 + glowAlpha * 0.08)
      : 'rgba(255, 255, 255, 0.05)';
    const glassBorderHi = isCustomTheme
      ? hexToRgba(surfaceAccentColor, 0.1 + glowAlpha * 0.12)
      : 'rgba(255, 255, 255, 0.1)';
    const featureShadow = glowActive
      ? `0 0 0 1px rgba(255, 255, 255, 0.03) inset, 0 12px 48px rgba(0, 0, 0, 0.34), 0 0 ${Math.round(26 + glowStrength * 44)}px ${hexToRgba(effectiveAccentColor, 0.12 + glowAlpha * 0.18)}`
      : '0 0 0 1px rgba(255, 255, 255, 0.03) inset, 0 8px 40px rgba(0, 0, 0, 0.3)';
    const headingAccent = gradientActive ? effectiveThemeGradientColorC : effectiveAccentColor;

    root.style.setProperty('--color-accent', effectiveAccentColor);
    root.style.setProperty('--color-accent-hover', hover);
    root.style.setProperty('--color-accent-glow', accentGlow);
    root.style.setProperty('--color-accent-selection', selection);
    root.style.setProperty('--color-accent-contrast', lum > 160 ? '#000000' : '#ffffff');
    root.style.setProperty('--bg-primary', bgPrimary);
    root.style.setProperty('--bg-titlebar', `rgba(${bgRgb}, 0.95)`);
    root.style.setProperty('--theme-app-background', TRANSPARENT_STACK);
    root.style.setProperty('--theme-app-background-size', '100% 100%, 100% 100%, 100% 100%');
    root.style.setProperty('--theme-gradient-speed', `${Math.max(6, themeGradientSpeed)}s`);
    root.style.setProperty('--theme-accent-gradient', accentGradient);
    root.style.setProperty('--theme-accent-gradient-hover', accentGradientHover);
    root.style.setProperty('--theme-accent-gradient-soft', accentGradientSoft);
    root.style.setProperty('--theme-accent-gradient-size', accentGradientSize);
    root.style.setProperty('--theme-accent-shadow', accentGlowShadow);
    root.style.setProperty('--theme-accent-shadow-strong', accentGlowStrong);
    root.style.setProperty('--theme-accent-soft-border', accentSoftBorder);
    root.style.setProperty('--theme-glass-blur', `${Math.max(12, glassBlur)}px`);
    root.style.setProperty('--theme-glass-saturate', `${glassSaturate}`);
    root.style.setProperty('--theme-glass-featured-saturate', `${glassFeaturedSaturate}`);
    root.style.setProperty(
      '--theme-glass-bg',
      `linear-gradient(180deg, rgba(255, 255, 255, 0.028), ${hexToRgba(accentGlassTint, glassTint)})`,
    );
    root.style.setProperty(
      '--theme-glass-flat-bg',
      `linear-gradient(180deg, rgba(255, 255, 255, 0.022), ${hexToRgba(accentGlassTint, glassTint * 0.82)})`,
    );
    root.style.setProperty(
      '--theme-glass-hover',
      `linear-gradient(180deg, rgba(255, 255, 255, 0.055), ${hexToRgba(accentGlassTint, glassHoverTint)})`,
    );
    root.style.setProperty(
      '--theme-glass-featured-bg',
      `linear-gradient(180deg, rgba(255, 255, 255, 0.03), ${hexToRgba(accentGlassTint, glassTint + 0.03)})`,
    );
    root.style.setProperty('--theme-glass-border', glassBorder);
    root.style.setProperty('--theme-glass-border-hi', glassBorderHi);
    root.style.setProperty('--theme-glass-shadow', featureShadow);
    root.style.setProperty(
      '--theme-greeting-gradient',
      gradientActive
        ? `linear-gradient(90deg, #ffffff 0%, rgba(255, 255, 255, 0.86) 34%, ${effectiveThemeGradientColorA} 58%, ${effectiveThemeGradientColorC} 100%)`
        : `linear-gradient(90deg, #ffffff 0%, rgba(255, 255, 255, 0.84) 48%, ${headingAccent} 100%)`,
    );
    root.style.setProperty(
      '--theme-heading-shadow',
      glowActive
        ? `drop-shadow(0 0 ${Math.round(14 + glowStrength * 18)}px ${hexToRgba(effectiveAccentColor, 0.12 + glowAlpha * 0.2)})`
        : 'none',
    );
    root.dataset.themePreset = themePreset;
    root.dataset.themeGradientAnimated = animateGradient ? 'true' : 'false';
    root.dataset.themeGradientAnimation = animateGradient ? themeGradientAnimation : 'none';
    root.style.backgroundColor = bgPrimary;
    document.body.style.backgroundColor = bgPrimary;
  }, [
    bgPrimary,
    effectiveAccentColor,
    effectiveThemeGradientColorA,
    effectiveThemeGradientColorB,
    effectiveThemeGradientColorC,
    glassBlur,
    lowPerformanceMode,
    themeGlowEnabled,
    themeGlowIntensity,
    themeGlowOpacity,
    themeGradientAngle,
    themeGradientAnimated,
    themeGradientAnimation,
    themeGradientEnabled,
    themeGradientSpeed,
    themeGradientFollowArtwork,
    themeGradientType,
    themePreset,
  ]);

  return <>{children}</>;
}
