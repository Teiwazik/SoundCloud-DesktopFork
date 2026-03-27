export interface LanguageInfo {
  code: string;
  name: string;
  nativeName: string;
  flags: string;
}

export const SUPPORTED_LANGUAGES: LanguageInfo[] = [
  { code: 'en', name: 'English', nativeName: 'English', flags: '🇬🇧' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский', flags: '🇷🇺' },
  { code: 'uk', name: 'Ukrainian', nativeName: 'Українська', flags: '🇺🇦' },
  { code: 'de', name: 'German', nativeName: 'Deutsch', flags: '🇩🇪' },
  { code: 'fr', name: 'French', nativeName: 'Français', flags: '🇫🇷' },
  { code: 'es', name: 'Spanish', nativeName: 'Español', flags: '🇪🇸' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português', flags: '🇧🇷' },
  { code: 'it', name: 'Italian', nativeName: 'Italiano', flags: '🇮🇹' },
  { code: 'pl', name: 'Polish', nativeName: 'Polski', flags: '🇵🇱' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語', flags: '🇯🇵' },
  { code: 'ko', name: 'Korean', nativeName: '한국어', flags: '🇰🇷' },
  { code: 'zh', name: 'Chinese', nativeName: '中文', flags: '🇨🇳' },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe', flags: '🇹🇷' },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', flags: '🇸🇦' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', flags: '🇮🇳' },
];

const LANGUAGE_PATTERNS: Record<string, RegExp> = {
  ru: /[\u0400-\u04FF]/,
  uk: /[\u0400-\u04FF]/,
  ar: /[\u0600-\u06FF]/,
  hi: /[\u0900-\u097F]/,
  ja: /[\u3040-\u30FF\u4E00-\u9FFF]/,
  ko: /[\uAC00-\uD7AF\u1100-\u11FF]/,
  zh: /[\u4E00-\u9FFF\u3400-\u4DBF]/,
  tr: /[\u00C0-\u00FF]/,
  de: /[\u00C0-\u00FF]/,
  fr: /[\u00C0-\u00FF]/,
  es: /[\u00C0-\u00FF]/,
  pt: /[\u00C0-\u00FF]/,
  it: /[\u00C0-\u00FF]/,
  pl: /[\u00C0-\u00FF]/,
};

function countChars(text: string, pattern: RegExp): number {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  const matches = text.match(globalPattern);
  return matches ? matches.length : 0;
}

function getCyrillicVariant(text: string): 'ru' | 'uk' | null {
  const cyrillicChars = text.match(/[\u0400-\u04FF]/g) || [];
  if (cyrillicChars.length === 0) return null;

  let ukraineIndicators = 0;
  let russianIndicators = 0;

  for (const char of cyrillicChars) {
    const code = char.charCodeAt(0);
    if (code >= 0x0400 && code <= 0x0427) {
      russianIndicators++;
    } else if (code >= 0x0428 && code <= 0x0491) {
      ukraineIndicators++;
    } else if (code >= 0x0492 && code <= 0x04ff) {
      ukraineIndicators++;
    }
  }

  if (ukraineIndicators > russianIndicators * 0.3) {
    return 'uk';
  }
  return 'ru';
}

export function detectLanguage(text: string): string {
  if (!text || text.trim().length < 3) {
    return 'en';
  }

  for (const [lang, pattern] of Object.entries(LANGUAGE_PATTERNS)) {
    const count = countChars(text, pattern);
    const ratio = count / text.length;

    if (ratio > 0.1) {
      if (lang === 'ru' || lang === 'uk') {
        const cyrillicVariant = getCyrillicVariant(text);
        return cyrillicVariant || lang;
      }
      return lang;
    }
  }

  return 'en';
}

export interface TrackLanguageProfile {
  trackId: number;
  languages: Record<string, number>;
  primaryLanguage: string;
  confidence: number;
}

export function analyzeTrackLanguage(track: {
  id: number;
  title: string;
  user?: { username: string };
  description?: string;
}): TrackLanguageProfile {
  const textParts = [track.title, track.user?.username || '', track.description || ''].join(' ');

  const langCounts: Record<string, number> = {};

  for (const lang of SUPPORTED_LANGUAGES) {
    const pattern = LANGUAGE_PATTERNS[lang.code];
    if (pattern) {
      langCounts[lang.code] = countChars(textParts, pattern);
    }
  }

  let primaryLanguage = 'en';
  let maxCount = 0;
  const totalChars = textParts.length || 1;

  for (const [lang, count] of Object.entries(langCounts)) {
    const ratio = count / totalChars;
    if (ratio > 0.1 && count > maxCount) {
      maxCount = count;
      if (lang === 'ru' || lang === 'uk') {
        primaryLanguage = getCyrillicVariant(textParts) || lang;
      } else {
        primaryLanguage = lang;
      }
    }
  }

  const confidence = Math.min((maxCount / totalChars) * 3, 1);

  return {
    trackId: track.id,
    languages: langCounts,
    primaryLanguage,
    confidence,
  };
}

export interface LanguageWaveData {
  distribution: Record<string, number>;
  percentages: Record<string, number>;
  totalTracks: number;
}

export function calculateLanguageDistribution(tracks: TrackLanguageProfile[]): LanguageWaveData {
  const distribution: Record<string, number> = {};
  let totalTracks = 0;

  for (const track of tracks) {
    if (track.confidence > 0.1) {
      distribution[track.primaryLanguage] = (distribution[track.primaryLanguage] || 0) + 1;
      totalTracks++;
    }
  }

  const percentages: Record<string, number> = {};
  if (totalTracks > 0) {
    for (const [lang, count] of Object.entries(distribution)) {
      percentages[lang] = Math.round((count / totalTracks) * 100);
    }
  }

  return { distribution, percentages, totalTracks };
}

export function filterByLanguage<T extends { id: number }>(
  tracks: T[],
  languageProfiles: Map<number, TrackLanguageProfile>,
  preferredLanguage: string,
): T[] {
  if (preferredLanguage === 'all') {
    return tracks;
  }

  return tracks.filter((track) => {
    const profile = languageProfiles.get(track.id);
    if (!profile) return false;
    return profile.primaryLanguage === preferredLanguage;
  });
}
