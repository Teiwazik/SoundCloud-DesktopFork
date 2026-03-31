import React from 'react';
import { useTranslation } from 'react-i18next';
import type { Track } from '../../stores/player';
import { useSettingsStore } from '../../stores/settings';

interface StreamQualityBadgeProps {
  quality?: Track['streamQuality'];
  codec?: Track['streamCodec'];
  access?: Track['access'];
  className?: string;
}

export const StreamQualityBadge = React.memo(
  ({ quality, codec, access, className = '' }: StreamQualityBadgeProps) => {
    const { t } = useTranslation();
    const highQualityStreaming = useSettingsStore((s) => s.highQualityStreaming);

    if (!highQualityStreaming) return null;

    const isHq = quality ? quality === 'hq' : access === 'playable';
    const label = isHq ? t('player.streamQualityHq', 'HQ') : t('player.streamQualityLq', 'LQ');
    const codecLabel = codec?.trim().toUpperCase();

    return (
      <span
        className={`text-[10px] font-semibold text-white/20 bg-white/[0.04] px-2 py-0.5 rounded-full border border-white/[0.06] ${className}`}
      >
        {codecLabel ? `${label} ${codecLabel}` : label}
      </span>
    );
  },
);
