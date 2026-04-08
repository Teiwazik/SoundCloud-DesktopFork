import { getCurrentWindow } from '@tauri-apps/api/window';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Disc3, Fullscreen, Minus, Square, X } from '../../lib/icons';
import { toggleWindowFullscreen } from '../../lib/window';

const NavButtons = React.memo(() => {
  const navigate = useNavigate();
  const location = useLocation();

  // track history length to enable/disable (basic heuristic)
  const canGoBack = location.key !== 'default';

  return (
    <div className="flex items-center gap-0.5 ml-2">
      <button
        type="button"
        disabled={!canGoBack}
        onClick={() => navigate(-1)}
        className="w-7 h-7 rounded-lg flex items-center justify-center transition-all duration-150 cursor-pointer disabled:opacity-20 disabled:cursor-default text-white/30 hover:text-white/60 hover:bg-white/[0.06] active:scale-90"
      >
        <ChevronLeft size={14} strokeWidth={2.5} />
      </button>
      <button
        type="button"
        onClick={() => navigate(1)}
        className="w-7 h-7 rounded-lg flex items-center justify-center transition-all duration-150 cursor-pointer text-white/30 hover:text-white/60 hover:bg-white/[0.06] active:scale-90"
      >
        <ChevronRight size={14} strokeWidth={2.5} />
      </button>
    </div>
  );
});

export const Titlebar = React.memo(() => {
  const { t } = useTranslation();
  const minimize = () => getCurrentWindow().minimize();
  const toggleMaximize = () => getCurrentWindow().toggleMaximize();
  const toggleFullscreen = () => void toggleWindowFullscreen();
  const close = () => getCurrentWindow().close();

  return (
    <div
      className="h-10 flex items-center justify-between px-4 select-none shrink-0 border-b border-white/[0.04]"
      data-tauri-drag-region
    >
      <div className="flex items-center gap-1.5" data-tauri-drag-region>
        <Disc3 size={14} className="text-accent" strokeWidth={2} />
        <span className="text-[11px] font-semibold tracking-tight text-white/30">SoundCloud</span>
        <NavButtons />
      </div>

      <div className="flex items-center">
        <button
          type="button"
          title={t('kb.fullscreen')}
          aria-label={t('kb.fullscreen')}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-white/20 hover:text-white/50 hover:bg-white/[0.04] transition-all duration-150 cursor-pointer"
          onClick={toggleFullscreen}
        >
          <Fullscreen size={12} />
        </button>
        <button
          type="button"
          className="w-8 h-8 rounded-lg flex items-center justify-center text-white/20 hover:text-white/50 hover:bg-white/[0.04] transition-all duration-150 cursor-pointer"
          onClick={minimize}
        >
          <Minus size={13} />
        </button>
        <button
          type="button"
          className="w-8 h-8 rounded-lg flex items-center justify-center text-white/20 hover:text-white/50 hover:bg-white/[0.04] transition-all duration-150 cursor-pointer"
          onClick={toggleMaximize}
        >
          <Square size={10} />
        </button>
        <button
          type="button"
          className="w-8 h-8 rounded-lg flex items-center justify-center text-white/20 hover:text-red-400 hover:bg-red-500/10 transition-all duration-150 cursor-pointer"
          onClick={close}
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
});
