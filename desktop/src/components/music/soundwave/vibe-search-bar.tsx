import React, { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Search, Sparkles, X } from '../../../lib/icons';

export interface VibeSearchBarHandle {
  clear: () => void;
}

interface Props {
  /** Fires only when the user commits (Enter or Search button), not on every keystroke. */
  onSubmit: (q: string) => void;
  /** Fires when user clicks X inside the input or Esc. */
  onClear: () => void;
  /** Whether a search request is currently in flight. */
  loading: boolean;
  /** Whether there's an active committed query (parent state). */
  active: boolean;
}

/**
 * Vibe-search input, fully uncontrolled. Keystrokes never re-render this
 * component nor its parent — the input value is held by the DOM itself.
 *
 * - Clear button visibility is driven by CSS `:placeholder-shown` (no JS state).
 * - The submit button doesn't disable based on length; we validate inside the
 *   handler. This trades a tiny correctness shim for a huge perf win.
 * - `clear()` is exposed imperatively so the parent can reset the input when
 *   the user dismisses the results from elsewhere (e.g. the "Back to wave"
 *   link in SearchHeader).
 */
export const VibeSearchBar = React.memo(
  React.forwardRef<VibeSearchBarHandle, Props>(function VibeSearchBar(
    { onSubmit, onClear, loading, active },
    ref,
  ) {
    const { t } = useTranslation();
    const inputRef = useRef<HTMLInputElement>(null);

    React.useImperativeHandle(ref, () => ({
      clear: () => {
        if (inputRef.current) inputRef.current.value = '';
      },
    }));

    const submit = () => {
      const q = inputRef.current?.value.trim() ?? '';
      if (q.length < 2) return;
      onSubmit(q);
    };

    const clear = () => {
      if (inputRef.current) inputRef.current.value = '';
      inputRef.current?.focus();
      onClear();
    };

    return (
      <div
        className="vibe-search relative rounded-2xl overflow-hidden transition-all duration-300 ease-[var(--ease-apple)]"
        data-active={active ? '' : undefined}
        style={{
          background: active
            ? 'linear-gradient(135deg, var(--color-accent-glow), rgba(255,255,255,0.03))'
            : 'rgba(255,255,255,0.03)',
          border: `1px solid ${active ? 'var(--color-accent-glow)' : 'rgba(255,255,255,0.08)'}`,
          boxShadow: active
            ? '0 0 32px var(--color-accent-glow), inset 0 1px 0 rgba(255,255,255,0.06)'
            : 'inset 0 1px 0 rgba(255,255,255,0.04)',
        }}
      >
        <div className="relative flex items-center gap-3 px-4 py-2.5">
          <div
            className="w-7 h-7 rounded-xl flex items-center justify-center shrink-0"
            style={{
              background: active
                ? 'var(--color-accent)'
                : 'linear-gradient(135deg, var(--color-accent-glow), rgba(255,255,255,0.08))',
              boxShadow: active ? '0 0 14px var(--color-accent-glow)' : undefined,
              transition: 'background 250ms var(--ease-apple), box-shadow 250ms',
            }}
          >
            <Sparkles
              size={13}
              style={{ color: active ? 'var(--color-accent-contrast)' : 'var(--color-accent)' }}
            />
          </div>

          <input
            ref={inputRef}
            type="text"
            defaultValue=""
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              } else if (e.key === 'Escape' && inputRef.current?.value) {
                e.preventDefault();
                clear();
              }
            }}
            placeholder={t('soundwave.searchPlaceholder')}
            className="vibe-search-input peer flex-1 bg-transparent text-[13.5px] font-medium text-white/95 placeholder:text-white/35 outline-none min-w-0"
          />

          <button
            type="button"
            onClick={clear}
            tabIndex={-1}
            title={t('soundwave.searchClear')}
            className="vibe-search-clear hidden peer-[:not(:placeholder-shown)]:flex w-7 h-7 rounded-full items-center justify-center text-white/40 hover:text-white/80 hover:bg-white/[0.06] transition-colors cursor-pointer shrink-0"
          >
            <X size={13} />
          </button>

          <button
            type="button"
            onClick={submit}
            disabled={loading}
            className="flex items-center gap-1.5 pl-3 pr-3 h-8 rounded-full font-semibold text-[12px] shrink-0 transition-all duration-200 ease-[var(--ease-apple)] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.97] hover:scale-[1.03]"
            style={{
              background: 'var(--color-accent)',
              color: 'var(--color-accent-contrast)',
              boxShadow:
                '0 4px 14px var(--color-accent-glow), inset 0 1px 0 rgba(255,255,255,0.22)',
            }}
          >
            {loading ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Search size={12} strokeWidth={2.5} />
            )}
            <span>{t('soundwave.searchAction')}</span>
          </button>
        </div>

        {active && (
          <div
            className="absolute bottom-0 left-0 right-0 h-[1px] pointer-events-none"
            aria-hidden
            style={{
              background:
                'linear-gradient(90deg, transparent, var(--color-accent) 50%, transparent)',
              animation: 'sw-shine 2.4s linear infinite',
            }}
          />
        )}
      </div>
    );
  }),
);
