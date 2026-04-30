import { DEFAULT_FONT_STACK, type AppFontMode } from '../stores/settings';

const STYLE_TAG_ID = 'app-font-face-style';
let registeredCustomPath: string | null = null;
let registeredBlobUrl: string | null = null;

function escapeFontFamily(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function quoteIfNeeded(name: string): string {
  // Already a stack (contains a comma) or already quoted/escaped — pass through.
  if (name.includes(',') || name.startsWith('"') || name.startsWith("'")) return name;
  return `"${escapeFontFamily(name)}"`;
}

function fontFaceCss(family: string, blobUrl: string, format: string): string {
  const safeFamily = escapeFontFamily(family);
  return `@font-face { font-family: "${safeFamily}"; src: url("${blobUrl}") format("${format}"); font-display: swap; }`;
}

function fileFormat(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || 'ttf';
  if (ext === 'otf') return 'opentype';
  if (ext === 'woff') return 'woff';
  if (ext === 'woff2') return 'woff2';
  return 'truetype';
}

function fileMime(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || 'ttf';
  if (ext === 'otf') return 'font/otf';
  if (ext === 'woff') return 'font/woff';
  if (ext === 'woff2') return 'font/woff2';
  return 'font/ttf';
}

/** Make a custom font available to the page. The path is in `<appData>/fonts`,
 *  which is in our plugin-fs scope, so we can read it from JS without a Rust
 *  round-trip. We hold one blob URL alive at a time — old ones are revoked
 *  when the path changes. */
export async function ensureCustomFontLoaded(
  path: string,
  family: string,
): Promise<void> {
  if (registeredCustomPath === path) return;

  const fs = await import('@tauri-apps/plugin-fs');
  const bytes = await fs.readFile(path);
  const blob = new Blob([bytes], { type: fileMime(path) });
  const blobUrl = URL.createObjectURL(blob);

  // Inject <style> with @font-face. We do this via a stylesheet rather than
  // the FontFace API because the document.fonts.add() approach doesn't reach
  // shadow DOMs and some lazy-rendered components — a regular @font-face
  // rule is observed everywhere.
  let tag = document.getElementById(STYLE_TAG_ID) as HTMLStyleElement | null;
  if (!tag) {
    tag = document.createElement('style');
    tag.id = STYLE_TAG_ID;
    document.head.appendChild(tag);
  }
  tag.textContent = fontFaceCss(family, blobUrl, fileFormat(path));

  // Force the loader to actually fetch it now so the first paint after
  // application doesn't flash the fallback.
  try {
    await document.fonts.load(`16px "${escapeFontFamily(family)}"`);
  } catch {
    /* noop — font may still load lazily */
  }

  if (registeredBlobUrl) URL.revokeObjectURL(registeredBlobUrl);
  registeredBlobUrl = blobUrl;
  registeredCustomPath = path;
}

export function clearCustomFont(): void {
  const tag = document.getElementById(STYLE_TAG_ID);
  if (tag) tag.remove();
  if (registeredBlobUrl) {
    URL.revokeObjectURL(registeredBlobUrl);
    registeredBlobUrl = null;
  }
  registeredCustomPath = null;
}

interface ApplyArgs {
  mode: AppFontMode;
  systemFamily: string | null;
  customPath: string | null;
  customFamily: string | null;
  /** Text size in px (the user-facing font-size slider). Drives all font-size
   *  declarations across the app via an override stylesheet. */
  textSize: number;
  /** UI scale multiplier (e.g. 1.0 = 100 %). Controls rem-based spacing/layout
   *  via the document's root font-size. */
  uiScale: number;
}

/** Reference text size for the override math. The slider's chosen value is
 *  expressed as a multiplier of this baseline (so 14 → ×1, 17 → ×1.214 …). */
const TEXT_SIZE_BASE = 14;
const TEXT_SCALE_STYLE_ID = 'app-text-scale-style';

/** Cached `(selector, fontSize-in-px)` pairs from every same-origin stylesheet
 *  in the document. Built once because re-scanning on every slider tick is
 *  expensive and the underlying rules don't change at runtime. */
type CachedTextRule = { selector: string; px: number };
let textRulesCache: CachedTextRule[] | null = null;
let lateScanTimer: number | null = null;

function scanTextRules(): CachedTextRule[] {
  const out: CachedTextRule[] = [];
  const visit = (rules: CSSRuleList) => {
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (rule instanceof CSSStyleRule) {
        const fs = rule.style.getPropertyValue('font-size').trim();
        if (!fs) continue;
        // Match plain px or rem values. Skip calc()/var()/% — anything that
        // isn't a literal number can't be safely re-scaled here.
        const m = fs.match(/^(-?\d+(?:\.\d+)?)(px|rem)$/);
        if (!m) continue;
        const px = m[2] === 'rem' ? parseFloat(m[1]) * 16 : parseFloat(m[1]);
        out.push({ selector: rule.selectorText, px });
      } else if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules) {
        // @media, @supports, @layer, @container — recurse.
        visit((rule as CSSGroupingRule).cssRules);
      }
    }
  };

  for (const sheet of Array.from(document.styleSheets)) {
    try {
      visit(sheet.cssRules);
    } catch {
      /* CORS-protected sheet — skip */
    }
  }
  return out;
}

function applyTextScale(scale: number, textSizePx: number): void {
  let tag = document.getElementById(TEXT_SCALE_STYLE_ID) as HTMLStyleElement | null;
  if (!tag) {
    tag = document.createElement('style');
    tag.id = TEXT_SCALE_STYLE_ID;
    // Append last so we win on equal-specificity ties without bumping
    // specificity ourselves.
    document.head.appendChild(tag);
  }

  // body font-size feeds inheritance for everything without an explicit class.
  document.body.style.fontSize = `${textSizePx}px`;

  if (Math.abs(scale - 1) < 0.001) {
    tag.textContent = '';
    return;
  }

  if (!textRulesCache) textRulesCache = scanTextRules();

  // Some Tailwind / Vite-injected stylesheets attach asynchronously after the
  // first apply call. Re-scan once shortly after, in case our cache is short.
  if (lateScanTimer == null && textRulesCache.length < 50) {
    lateScanTimer = window.setTimeout(() => {
      textRulesCache = scanTextRules();
      // Re-render with the same scale so newly seen rules get overrides.
      const root = document.documentElement;
      const cur = parseFloat(root.dataset.appTextScale || '1');
      const curPx = parseFloat(root.dataset.appTextSize || `${TEXT_SIZE_BASE}`);
      applyTextScale(cur, curPx);
    }, 600);
  }

  // Group identical selectors to keep the stylesheet small.
  const out: string[] = [];
  for (const r of textRulesCache) {
    out.push(`${r.selector}{font-size:${(r.px * scale).toFixed(3)}px !important}`);
  }
  tag.textContent = out.join('\n');

  // Stash for re-renders triggered by the late scan.
  document.documentElement.dataset.appTextScale = String(scale);
  document.documentElement.dataset.appTextSize = String(textSizePx);
}

/** Apply font settings to the document root. Idempotent — safe to call on
 *  every settings change. */
export async function applyAppFont(args: ApplyArgs): Promise<void> {
  const root = document.documentElement;
  let stack = DEFAULT_FONT_STACK;

  if (args.mode === 'system' && args.systemFamily) {
    stack = `${quoteIfNeeded(args.systemFamily)}, ${DEFAULT_FONT_STACK}`;
  } else if (args.mode === 'custom' && args.customPath && args.customFamily) {
    try {
      await ensureCustomFontLoaded(args.customPath, args.customFamily);
      stack = `${quoteIfNeeded(args.customFamily)}, ${DEFAULT_FONT_STACK}`;
    } catch (e) {
      console.error('[appFont] failed to load custom font, falling back', e);
      stack = DEFAULT_FONT_STACK;
    }
  } else {
    clearCustomFont();
  }

  root.style.setProperty('--font-sans', stack);
  // UI scale → root font-size in px. rem-based spacing/widths follow.
  root.style.fontSize = `${16 * args.uiScale}px`;

  // Text scale → override every literal `font-size: Npx|Nrem` rule via a
  // last-loaded stylesheet, so explicit Tailwind `text-[Npx]` utilities shrink
  // / grow without affecting layout.
  applyTextScale(args.textSize / TEXT_SIZE_BASE, args.textSize);
}
