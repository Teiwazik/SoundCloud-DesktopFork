import React from 'react';
import { useTranslation } from 'react-i18next';
import { AudioLines, Compass } from '../../../lib/icons';
import { useSettingsStore } from '../../../stores/settings';

/**
 * Two-state toggle "Похожее / Разное" для SoundWave. Один клик = одно
 * изменение store. Без слайдеров, без дебаунсов, без ре-рендеров во время драга.
 */
export const ModeToggle = React.memo(function ModeToggle() {
  const { t } = useTranslation();
  const mode = useSettingsStore((s) => s.soundwaveMode);
  const setMode = useSettingsStore((s) => s.setSoundwaveMode);

  const isSimilar = mode === 'similar';

  const btn =
    'flex items-center gap-1.5 px-3 h-7 rounded-full text-[11px] font-medium transition-colors duration-150 cursor-pointer';
  const active = 'bg-white/[0.12] text-white/95';
  const idle = 'text-white/55 hover:text-white/80';

  return (
    <div
      className="flex items-center gap-0.5 p-1 rounded-full bg-white/[0.04] border border-white/[0.08]"
      title={t('soundwave.modeTitle')}
    >
      <button
        type="button"
        onClick={() => setMode('similar')}
        className={`${btn} ${isSimilar ? active : idle}`}
        aria-pressed={isSimilar}
      >
        <AudioLines size={11} style={{ color: isSimilar ? 'var(--color-accent)' : undefined }} />
        <span>{t('soundwave.modeSimilar')}</span>
      </button>
      <button
        type="button"
        onClick={() => setMode('diverse')}
        className={`${btn} ${!isSimilar ? active : idle}`}
        aria-pressed={!isSimilar}
      >
        <Compass size={11} style={{ color: !isSimilar ? 'var(--color-accent)' : undefined }} />
        <span>{t('soundwave.modeDiverse')}</span>
      </button>
    </div>
  );
});
