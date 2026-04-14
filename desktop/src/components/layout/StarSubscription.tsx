import * as Dialog from '@radix-ui/react-dialog';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Star, X } from '../../lib/icons';
import { useSubscription } from '../../lib/subscription';
import { useAuthStore } from '../../stores/auth';

const MODAL_PARTICLES = Array.from({ length: 20 }, (_, i) => i);

const PERKS = [
  'star.perkGoPlus',
  'star.perkServer',
  'star.perkHQ',
  'star.bypassWhitelist',
  'star.perkSupport',
] as const;

const STEPS = [
  { key: 'star.step1', link: 'https://boosty.to/lolinamide' },
  { key: 'star.step2' },
  { key: 'star.step3', link: 'https://discord.gg/xQcGBP8fGG' },
  { key: 'star.step4' },
  { key: 'star.step5' },
] as const;

export const StarBadge = React.memo(() => (
  <span
    className="inline-flex items-center gap-[3px] px-[6px] py-[1px] rounded-full text-[9px] font-bold uppercase tracking-wider text-white/90 shrink-0"
    style={{
      background:
        'linear-gradient(135deg, rgba(139,92,246,0.35), rgba(168,85,247,0.25), rgba(192,132,252,0.2))',
      boxShadow: 'inset 0 0.5px 0 rgba(255,255,255,0.15), 0 0 8px rgba(139,92,246,0.25)',
      border: '0.5px solid rgba(168,85,247,0.3)',
    }}
  >
    <Star size={10} fill="currentColor" className="text-amber-400" />
    Star
  </span>
));

interface StarCardProps {
  collapsed: boolean;
  isPremium: boolean;
  onOpenModal: () => void;
}

export const StarCard = React.memo(({ collapsed, isPremium, onOpenModal }: StarCardProps) => {
  const { t } = useTranslation();

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onOpenModal}
        title={t('star.title')}
        className="flex items-center justify-center w-full px-3 py-2 rounded-xl text-[12px] font-medium text-white/40 hover:text-amber-400 hover:bg-white/[0.04] transition-all duration-200 cursor-pointer"
      >
        <Star size={16} fill="currentColor" strokeWidth={1.8} />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpenModal}
      className="flex items-center gap-2.5 w-full px-3 py-2 rounded-xl text-[12px] font-medium text-white/40 hover:text-amber-400 hover:bg-white/[0.04] transition-all duration-200 cursor-pointer"
    >
      <Star size={16} fill="currentColor" strokeWidth={1.8} className="shrink-0" />
      <span className="truncate">{isPremium ? t('star.active') : t('star.title')}</span>
    </button>
  );
});

export const StarModal = React.memo(
  ({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) => {
    const { t } = useTranslation();

    return (
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay
            className="dialog-overlay fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center"
            data-state={open ? 'open' : 'closed'}
          >
            <Dialog.Content
              className="dialog-content z-50 w-[420px] max-w-[90vw] max-h-[85vh] rounded-2xl overflow-hidden outline-none flex flex-col"
              data-state={open ? 'open' : 'closed'}
              style={{
                background:
                  'linear-gradient(165deg, rgba(30,15,50,0.95), rgba(20,10,40,0.97), rgba(15,8,30,0.98))',
                border: '0.5px solid rgba(168,85,247,0.25)',
                boxShadow:
                  '0 25px 60px rgba(0,0,0,0.5), 0 0 40px rgba(139,92,246,0.15), inset 0 1px 0 rgba(255,255,255,0.05)',
              }}
            >
            <div
              className="absolute inset-0 overflow-hidden pointer-events-none"
              style={{ contain: 'strict', transform: 'translateZ(0)' }}
            >
              {MODAL_PARTICLES.map((i) => (
                <div
                  key={i}
                  className="absolute rounded-full"
                  style={{
                    width: `${2 + (i % 3)}px`,
                    height: `${2 + (i % 3)}px`,
                    background: `hsl(${250 + ((i * 15) % 70)}, 75%, ${65 + ((i * 7) % 30)}%)`,
                    left: `${5 + ((i * 31) % 90)}%`,
                    top: `${5 + ((i * 47) % 90)}%`,
                    opacity: 0.3 + (i % 4) * 0.15,
                    animation: `star-float ${4 + (i % 4)}s ease-in-out ${(i * 0.3) % 4}s infinite alternate`,
                  }}
                />
              ))}
            </div>

            <div
              className="absolute top-0 left-1/2 -translate-x-1/2 w-3/4 h-32 pointer-events-none"
              style={{
                background: 'radial-gradient(ellipse, rgba(139,92,246,0.2) 0%, transparent 70%)',
                transform: 'translateZ(0)',
              }}
            />

            <div
              className="relative overflow-y-auto p-6 star-scroll"
              style={{ isolation: 'isolate' }}
            >
              <Dialog.Close className="absolute top-4 right-4 p-1 rounded-lg text-white/30 hover:text-white/70 hover:bg-white/[0.06] transition-colors cursor-pointer">
                <X size={16} />
              </Dialog.Close>

              <div className="flex flex-col items-center text-center mb-6">
                <span
                  className="text-amber-400 mb-3"
                  style={{ filter: 'drop-shadow(0 0 12px rgba(168,85,247,0.6))' }}
                >
                  <Star size={36} fill="currentColor" />
                </span>
                <Dialog.Title className="flex items-center gap-2 text-xl font-bold text-white/95 tracking-tight">
                  <Star size={20} fill="currentColor" className="text-amber-400" />
                  {t('star.modalTitle')}
                </Dialog.Title>
                <p className="text-[12px] text-purple-300/50 mt-1 font-medium">
                  {t('star.modalSub')}
                </p>
              </div>

              <div className="space-y-2 mb-6">
                {PERKS.map((perk) => (
                  <div
                    key={perk}
                    className="flex items-start gap-3 px-3.5 py-2.5 rounded-xl"
                    style={{
                      background:
                        'linear-gradient(135deg, rgba(139,92,246,0.1), rgba(168,85,247,0.05))',
                      border: '0.5px solid rgba(168,85,247,0.12)',
                    }}
                  >
                    <span className="text-purple-400/80 text-[13px] mt-px shrink-0">✦</span>
                    <span className="text-[12.5px] text-white/75 leading-relaxed">{t(perk)}</span>
                  </div>
                ))}
              </div>

              <div
                className="h-px mb-5"
                style={{
                  background:
                    'linear-gradient(90deg, transparent, rgba(168,85,247,0.2), transparent)',
                }}
              />

              <div className="mb-2">
                <h3 className="text-[12px] font-semibold text-white/60 uppercase tracking-wider mb-3">
                  {t('star.howTo')}
                </h3>
                <div className="space-y-2.5">
                  {STEPS.map((step, i) => (
                    <div key={step.key} className="flex items-start gap-3">
                      <span
                        className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-purple-300/80 mt-0.5"
                        style={{
                          background:
                            'linear-gradient(135deg, rgba(139,92,246,0.2), rgba(168,85,247,0.1))',
                          border: '0.5px solid rgba(168,85,247,0.2)',
                        }}
                      >
                        {i + 1}
                      </span>
                      <div className="flex-1 min-w-0">
                        <span className="text-[12px] text-white/65 leading-relaxed">
                          {t(step.key)}
                        </span>
                        {'link' in step && step.link && (
                          <a
                            href={step.link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 mt-1 px-2.5 py-1 rounded-lg text-[11px] font-medium text-purple-300/80 hover:text-purple-200 transition-colors cursor-pointer"
                            style={{
                              background:
                                'linear-gradient(135deg, rgba(139,92,246,0.15), rgba(168,85,247,0.08))',
                              border: '0.5px solid rgba(168,85,247,0.2)',
                            }}
                          >
                            {t(i === 0 ? 'star.goBoosty' : 'star.goDiscord')}
                            <ExternalLink size={10} />
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
      </Dialog.Root>
    );
  },
);

export function useStarSubscription() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const { data: isPremium } = useSubscription(isAuthenticated);
  const [modalOpen, setModalOpen] = useState(false);
  const openModal = useCallback(() => setModalOpen(true), []);

  return { isPremium: !!isPremium, modalOpen, setModalOpen, openModal };
}
