import React from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Sparkles, X } from '../../../lib/icons';

/** Small framed icon chip shared by section headers. */
const IconChip = React.memo(function IconChip({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="w-6 h-6 rounded-lg flex items-center justify-center"
      style={{
        background: 'linear-gradient(135deg, var(--color-accent-glow), rgba(255,255,255,0.05))',
        border: '1px solid var(--color-accent-glow)',
      }}
    >
      {children}
    </div>
  );
});

/** "For you" — header above personalized recommendations. */
export const RecommendationsHeader = React.memo(function RecommendationsHeader() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 mb-3 px-1">
      <IconChip>
        <ChevronRight size={11} style={{ color: 'var(--color-accent)' }} />
      </IconChip>
      <span className="text-[12px] font-semibold text-white/80">{t('soundwave.forYou')}</span>
    </div>
  );
});

interface SearchHeaderProps {
  query: string;
  count: number;
  onClear: () => void;
}

/** Search-results header with reset link. */
export const SearchHeader = React.memo(function SearchHeader({
  query,
  count,
  onClear,
}: SearchHeaderProps) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2.5 mb-3 px-1">
      <IconChip>
        <Sparkles size={11} style={{ color: 'var(--color-accent)' }} />
      </IconChip>
      <span className="text-[12px] font-semibold text-white/80">
        {t('soundwave.searchResultsFor', { q: query })}
      </span>
      {count > 0 && (
        <span className="text-[10.5px] tabular-nums text-white/35 font-medium">
          · {t('soundwave.searchResultsCount', { count })}
        </span>
      )}
      <button
        type="button"
        onClick={onClear}
        className="ml-auto flex items-center gap-1 text-[10.5px] text-white/40 hover:text-white/80 transition-colors cursor-pointer"
      >
        <X size={10} />
        {t('soundwave.searchReset')}
      </button>
    </div>
  );
});
