import { ChevronDown, Globe, Languages } from 'lucide-react';
import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { calculateLanguageDistribution, SUPPORTED_LANGUAGES } from '../../lib/language-detection';
import { useSettingsStore } from '../../stores/settings';
import { useSoundWaveStore } from '../../stores/soundwave';

interface LanguageBarProps {
  code: string;
  percentage: number;
  isSelected: boolean;
  onClick: () => void;
}

const LanguageBar = memo<LanguageBarProps>(({ code, percentage, isSelected, onClick }) => {
  const lang = SUPPORTED_LANGUAGES.find((l) => l.code === code);
  if (!lang) return null;

  const flagEmojiStyle: CSSProperties = {
    fontFamily: `'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif`,
  };

  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 w-full group transition-all ${
        isSelected ? 'bg-white/10' : 'hover:bg-white/5'
      }`}
    >
      <span className="text-sm w-7 text-right" style={flagEmojiStyle}>
        {lang.flags}
      </span>
      <span className="text-xs w-16 text-left text-white/70 group-hover:text-white">
        {lang.flags === '🇷🇺' ? 'Русский' : lang.flags === '🇬🇧' ? 'English' : lang.nativeName}
      </span>
      <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            isSelected ? 'bg-orange-500' : 'bg-white/20'
          }`}
          style={{ width: `${Math.max(percentage, 3)}%` }}
        />
      </div>
      <span className="text-[10px] w-8 text-right text-white/40">{percentage}%</span>
    </button>
  );
});

LanguageBar.displayName = 'LanguageBar';

export const LanguageWavePanel = memo(() => {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  const languageFilterEnabled = useSettingsStore((s) => s.languageFilterEnabled);
  const preferredLanguage = useSettingsStore((s) => s.preferredLanguage);
  const setLanguageFilterEnabled = useSettingsStore((s) => s.setLanguageFilterEnabled);
  const setPreferredLanguage = useSettingsStore((s) => s.setPreferredLanguage);

  const detectedTracks = useSoundWaveStore((s) => s.detectedLanguages);
  const isActive = useSoundWaveStore((s) => s.isActive);

  const distribution = calculateLanguageDistribution(detectedTracks);
  const topLanguages = Object.entries(distribution.percentages)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 6);

  const selectedLang = SUPPORTED_LANGUAGES.find((l) => l.code === preferredLanguage);
  const flagEmojiStyle: CSSProperties = {
    fontFamily: `'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif`,
  };
  const selectedLabel =
    preferredLanguage === 'all'
      ? t('languageWaveAll')
      : selectedLang?.flags +
        ' ' +
        (selectedLang?.flags === '🇷🇺' ? 'Русский' : selectedLang?.name || preferredLanguage);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !isActive || !languageFilterEnabled) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let phase = 0;

    const resize = () => {
      canvas.width = canvas.offsetWidth * window.devicePixelRatio;
      canvas.height = canvas.offsetHeight * window.devicePixelRatio;
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    };

    const draw = () => {
      const w = canvas.offsetWidth;
      const h = canvas.offsetHeight;
      if (w === 0 || h === 0) {
        animationFrameId = requestAnimationFrame(draw);
        return;
      }

      if (document.visibilityState === 'hidden') {
        animationFrameId = requestAnimationFrame(draw);
        return;
      }

      ctx.clearRect(0, 0, w, h);
      phase += 0.02;

      const bars = topLanguages.length || 5;
      const barWidth = w / bars;
      const maxHeight = h * 0.8;

      topLanguages.forEach(([, percentage], i) => {
        const x = i * barWidth + barWidth / 2;
        const targetHeight = (percentage / 100) * maxHeight;
        const waveOffset = Math.sin(phase + i * 0.5) * 3;
        const barHeight = targetHeight + waveOffset;

        const gradient = ctx.createLinearGradient(0, h - barHeight, 0, h);
        gradient.addColorStop(0, `rgba(255, 85, 0, ${0.6 + percentage / 200})`);
        gradient.addColorStop(1, 'rgba(255, 85, 0, 0.1)');

        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.roundRect(x - barWidth * 0.35, h - barHeight, barWidth * 0.7, barHeight, 4);
        ctx.fill();
      });

      animationFrameId = requestAnimationFrame(draw);
    };

    window.addEventListener('resize', resize);
    resize();
    animationFrameId = requestAnimationFrame(draw);

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(animationFrameId);
    };
  }, [isActive, languageFilterEnabled, topLanguages]);

  if (!isActive) return null;

  return (
    <div className="relative">
      <div className="relative w-full h-16 rounded-2xl overflow-hidden bg-[#0a0a0c]/50 border border-white/[0.04]">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full pointer-events-none opacity-60"
        />
        <div className="absolute inset-0 flex items-center justify-between px-4">
          <div className="flex items-center gap-3">
            <Globe size={16} className="text-white/50" />
            <span className="text-xs text-white/40">Language Wave</span>
            {topLanguages.length > 0 && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/10 text-white/60">
                <span style={flagEmojiStyle}>
                  {topLanguages[0][0] === 'en'
                    ? '🇬🇧'
                    : topLanguages[0][0] === 'ru'
                      ? '🇷🇺'
                      : topLanguages[0][0] || '?'}
                </span>{' '}
                {topLanguages[0][1]}%
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setLanguageFilterEnabled(!languageFilterEnabled)}
              className={`px-3 py-1 rounded-full text-[10px] font-bold transition-all ${
                languageFilterEnabled
                  ? 'bg-orange-500 text-white'
                  : 'bg-white/10 text-white/50 hover:text-white'
              }`}
            >
              {languageFilterEnabled ? t('languageWaveEnabled') : t('languageWaveDisabled')}
            </button>

            <div className="relative">
              <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/10 text-white/70 hover:text-white text-[10px] font-bold transition-all"
              >
                <Languages size={12} />
                <span>{selectedLabel}</span>
                <ChevronDown
                  size={10}
                  className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                />
              </button>

              {isExpanded && (
                <div className="absolute bottom-full right-0 mb-2 w-56 bg-[#1a1a1f] border border-white/10 rounded-2xl p-3 shadow-2xl z-50">
                  <button
                    onClick={() => {
                      setPreferredLanguage('all');
                      setIsExpanded(false);
                    }}
                    className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium transition-all mb-1 ${
                      preferredLanguage === 'all'
                        ? 'bg-white/15 text-white'
                        : 'text-white/50 hover:text-white hover:bg-white/5'
                    }`}
                  >
                    <Globe size={14} />
                    <span>{t('languageWaveAll')}</span>
                  </button>

                  <div className="border-t border-white/5 pt-2 space-y-0.5 max-h-48 overflow-y-auto">
                    {topLanguages.map(([code, percentage]) => {
                      const lang = SUPPORTED_LANGUAGES.find((l) => l.code === code);
                      if (!lang) return null;
                      return (
                        <button
                          key={code}
                          onClick={() => {
                            setPreferredLanguage(code);
                            setIsExpanded(false);
                          }}
                          className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium transition-all ${
                            preferredLanguage === code
                              ? 'bg-white/15 text-white'
                              : 'text-white/50 hover:text-white hover:bg-white/5'
                          }`}
                    >
                      <span style={flagEmojiStyle}>{lang.flags}</span>
                      <span className="flex-1 text-left">
                        {lang.flags === '🇷🇺' ? 'Русский' : lang.nativeName}
                      </span>
                          <span className="text-white/40">{percentage}%</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {isExpanded && <div className="fixed inset-0 z-40" onClick={() => setIsExpanded(false)} />}
    </div>
  );
});

LanguageWavePanel.displayName = 'LanguageWavePanel';
