import type React from 'react';
import { Play } from '../../lib/icons';
import { useTilt } from '../../lib/hooks/useTilt';

interface MixCardProps {
  index: number;
  title: string;
  subtitle: string;
  artworkUrl?: string;
  color: string;
  onClick: () => void;
}

export const MixCard: React.FC<MixCardProps> = ({
  index,
  title,
  subtitle,
  artworkUrl,
  color,
  onClick,
}) => {
  const { ref, onMouseMove, onMouseLeave } = useTilt();

  return (
    <div
      ref={ref}
      className="mix-card w-[200px] shrink-0 cursor-pointer group"
      onClick={onClick}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
    >
      <div
        className="relative aspect-square rounded-2xl overflow-hidden bg-cover bg-center transition-shadow duration-300 shadow-lg group-hover:shadow-2xl border border-white/[0.05]"
        style={{
          backgroundImage: artworkUrl ? `url(${artworkUrl})` : `linear-gradient(135deg, ${color}, #1a1a2e)`,
        }}
      >
        <div className="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
        
        <div className="absolute bottom-0 left-0 right-0 p-3 flex items-end justify-between">
          <span
            className="mix-card-label px-2.5 py-1 rounded-md text-[13px] font-extrabold text-white tracking-wider shadow-sm"
            style={{ backgroundColor: color }}
          >
            MIX {index + 1}
          </span>
          
          <button
            className="w-10 h-10 rounded-full bg-black/60 backdrop-blur-md flex items-center justify-center text-white opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-300 hover:bg-accent hover:scale-110"
            onClick={(e) => {
              e.stopPropagation();
              onClick();
            }}
          >
            <Play size={18} fill="currentColor" className="ml-0.5" />
          </button>
        </div>
      </div>

      <div className="mt-3 px-1">
        <h3 className="text-[13px] font-semibold text-white/90 truncate">{title}</h3>
        <p className="text-[11px] text-white/40 truncate mt-0.5">{subtitle}</p>
      </div>
    </div>
  );
};
