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
  { code: 'kk', name: 'Kazakh', nativeName: 'Қазақша', flags: '🇰🇿' },
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
  kk: /[\u0400-\u04FF]/,
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

const LATIN_LANGUAGE_HINTS: Record<string, string[]> = {
  de: [' und ', ' ich ', ' nicht ', ' liebe ', ' mit ', ' auf ', ' fuer ', 'für '],
  fr: [' je ', ' tu ', ' est ', ' avec ', ' dans ', ' une ', ' des ', ' pour '],
  es: [' que ', ' con ', ' para ', ' esta ', ' esta ', ' una ', ' el ', ' la '],
  pt: [' voce ', ' você ', ' nao ', ' não ', ' com ', ' uma ', ' pra ', ' meu '],
  it: [' che ', ' con ', ' per ', ' una ', ' sono ', ' amore ', ' della ', ' mio '],
  pl: [' sie ', ' się ', ' nie ', ' jest ', ' dla ', ' moje ', ' twoje ', ' oraz '],
  tr: [' ve ', ' bir ', ' ask ', ' aşk ', ' ben ', ' sen ', ' icin ', ' için '],
};

function countChars(text: string, pattern: RegExp): number {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  const matches = text.match(globalPattern);
  return matches ? matches.length : 0;
}

function getCyrillicVariant(text: string): 'ru' | 'uk' | 'kk' | null {
  const cyrillicChars = text.match(/[\u0400-\u04FF]/g) || [];
  if (cyrillicChars.length === 0) return null;

  let ukIndicators = 0;
  let ruIndicators = 0;
  let kkIndicators = 0;

  for (const char of text.toLowerCase()) {
    if ('іїєґ'.includes(char)) ukIndicators += 2;
    if ('ёыэъ'.includes(char)) ruIndicators += 2;
    if ('әғқңөұүһ'.includes(char)) kkIndicators += 2.4;
    if (char === 'і') kkIndicators += 0.7;
    if (char === 'й') ruIndicators += 0.2;
  }

  if (kkIndicators > 0 && ukIndicators === 0 && ruIndicators === 0) {
    return 'kk';
  }
  if (ukIndicators > 0 && ruIndicators === 0 && kkIndicators < 1) {
    return 'uk';
  }
  if (ruIndicators > 0 && ukIndicators === 0 && kkIndicators < 1) {
    return 'ru';
  }

  if (kkIndicators > ukIndicators + 0.8 && kkIndicators > ruIndicators + 0.8) return 'kk';
  if (ukIndicators > ruIndicators + 0.8 && ukIndicators > kkIndicators + 0.3) return 'uk';
  if (ruIndicators > ukIndicators + 0.8 && ruIndicators > kkIndicators + 0.3) return 'ru';

  if (kkIndicators >= 1.6 && kkIndicators >= ukIndicators && kkIndicators >= ruIndicators) {
    return 'kk';
  }

  return 'ru';
}

function detectLatinLanguageByKeywords(text: string): string | null {
  const normalized = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ')} `;
  let bestLang: string | null = null;
  let bestScore = 0;

  for (const [lang, hints] of Object.entries(LATIN_LANGUAGE_HINTS)) {
    let score = 0;
    for (const hint of hints) {
      if (normalized.includes(hint)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestLang = lang;
    }
  }

  return bestScore >= 2 ? bestLang : null;
}

export function detectLanguage(text: string): string {
  if (!text || text.trim().length < 3) {
    return 'en';
  }

  const cyrillicVariant = getCyrillicVariant(text);
  if (cyrillicVariant) return cyrillicVariant;

  for (const scriptLang of ['ar', 'hi', 'ja', 'ko', 'zh']) {
    const pattern = LANGUAGE_PATTERNS[scriptLang];
    if (pattern && countChars(text, pattern) > 0) {
      return scriptLang;
    }
  }

  const latinHint = detectLatinLanguageByKeywords(text);
  if (latinHint) {
    return latinHint;
  }

  for (const [lang, pattern] of Object.entries(LANGUAGE_PATTERNS)) {
    const count = countChars(text, pattern);
    const ratio = count / text.length;

    if (ratio > 0.1) {
      if (lang === 'ru' || lang === 'uk' || lang === 'kk') {
        const variant = getCyrillicVariant(text);
        return variant || lang;
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
  const detected = detectLanguage(textParts);

  const langCounts: Record<string, number> = {};

  for (const lang of SUPPORTED_LANGUAGES) {
    const pattern = LANGUAGE_PATTERNS[lang.code];
    if (pattern) {
      langCounts[lang.code] = countChars(textParts, pattern);
    }
  }

  let primaryLanguage = detected;
  let maxCount = 0;
  const totalChars = textParts.length || 1;

  for (const [lang, count] of Object.entries(langCounts)) {
    const ratio = count / totalChars;
    if (ratio > 0.1 && count > maxCount) {
      maxCount = count;
      if (lang === 'ru' || lang === 'uk' || lang === 'kk') {
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
  preferredLanguage: string | string[],
): T[] {
  const preferredLanguages = Array.isArray(preferredLanguage)
    ? preferredLanguage
        .map((lang) => lang.trim().toLowerCase())
        .filter((lang) => lang && lang !== 'all')
    : preferredLanguage === 'all'
      ? []
      : [preferredLanguage.trim().toLowerCase()].filter(Boolean);

  if (preferredLanguages.length === 0) {
    return tracks;
  }

  const preferredLanguageSet = new Set(preferredLanguages);

  return tracks.filter((track) => {
    const profile = languageProfiles.get(track.id);
    if (!profile) return false;
    return preferredLanguageSet.has(profile.primaryLanguage);
  });
}
