import { openUrl } from '@tauri-apps/plugin-opener';
import { isTauri } from '@tauri-apps/api/core';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { DEFAULT_API_BASE, getApiBase } from '../lib/constants';
import { Check, ClipboardCopy, Disc3 } from '../lib/icons';
import { queryClient } from '../main';
import { useAuthStore } from '../stores/auth';
import { useSettingsStore } from '../stores/settings';

interface LoginResponse {
  url: string;
  sessionId: string;
}

interface SessionResponse {
  authenticated: boolean;
}

export function Login() {
  const { t } = useTranslation();
  const setSession = useAuthStore((s) => s.setSession);
  const fetchUser = useAuthStore((s) => s.fetchUser);
  const apiMode = useSettingsStore((s) => s.apiMode);
  const customApiKey = useSettingsStore((s) => s.customApiKey);
  const setApiMode = useSettingsStore((s) => s.setApiMode);
  const setCustomApiKey = useSettingsStore((s) => s.setCustomApiKey);
  const [loading, setLoading] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canUseCustomApi = apiMode === 'auto' || Boolean(customApiKey.trim());

  useEffect(() => {
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

  const handleLogin = async () => {
    if (pollRef.current) clearTimeout(pollRef.current);
    setLoading(true);
    try {
      const { url, sessionId } = await api<LoginResponse>('/auth/login');
      setAuthUrl(url);
      if (isTauri()) {
        try {
          await openUrl(url);
        } catch {
          window.open(url, '_blank', 'noopener,noreferrer');
        }
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }

      const pollSession = async () => {
        try {
          const data = await api<SessionResponse>('/auth/session', {
            headers: { 'x-session-id': sessionId },
          });
          if (data.authenticated) {
            if (pollRef.current) clearTimeout(pollRef.current);
            pollRef.current = null;
            setSession(sessionId);
            await fetchUser();
            queryClient.invalidateQueries();
            return;
          }
        } catch {}
        pollRef.current = setTimeout(pollSession, 2000);
      };

      pollRef.current = setTimeout(pollSession, 2000);
    } catch (e) {
      console.error('Login failed:', e);
      setLoading(false);
    }
  };

  return (
    <div className="h-screen flex items-center justify-center relative overflow-hidden">
      {/* Background ambient glow */}
      <div className="absolute inset-0">
        <div className="absolute top-1/4 left-1/4 w-[500px] h-[500px] rounded-full bg-accent/[0.04] blur-[120px]" />
        <div className="absolute bottom-1/4 right-1/4 w-[400px] h-[400px] rounded-full bg-purple-500/[0.03] blur-[120px]" />
      </div>

      <div className="relative flex flex-col items-center gap-8 max-w-sm w-full mx-4">
        {/* Logo */}
        <div className="relative">
          <div className="absolute inset-0 bg-accent/20 blur-2xl rounded-full scale-150" />
          <div className="relative w-20 h-20 rounded-[22px] bg-white/[0.04] backdrop-blur-xl border border-white/[0.08] flex items-center justify-center shadow-[0_0_40px_rgba(255,85,0,0.1)]">
            <Disc3 size={36} className="text-accent" strokeWidth={1.5} />
          </div>
        </div>

        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight">SoundCloud Desktop</h1>
          <p className="text-[13px] text-white/30 mt-2">
            {loading ? t('auth.signingIn') : t('auth.loginSubtitle')}
          </p>
        </div>

        <div className="w-full rounded-[24px] border border-white/[0.06] bg-white/[0.03] p-3 backdrop-blur-xl space-y-3">
          <div className="flex gap-2">
            {(['auto', 'custom'] as const).map((mode) => {
              const active = apiMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setApiMode(mode)}
                  className={`flex-1 rounded-2xl px-3 py-2 text-[12px] font-semibold transition-all ${
                    active
                      ? 'bg-white/[0.12] text-white border border-white/[0.12]'
                      : 'bg-white/[0.03] text-white/45 border border-white/[0.05] hover:text-white/70 hover:bg-white/[0.06]'
                  }`}
                >
                  {mode === 'auto' ? t('settings.apiModeAuto') : t('settings.apiModeCustom')}
                </button>
              );
            })}
          </div>

          <div className="space-y-1.5">
            <p className="text-[11px] font-medium text-white/42">
              {t('settings.currentApiServer')}: {getApiBase()}
            </p>
            {apiMode === 'custom' ? (
              <>
                <input
                  type="text"
                  value={customApiKey}
                  onChange={(e) => setCustomApiKey(e.target.value)}
                  placeholder="SoundCloud Client ID"
                  className="w-full rounded-2xl border border-white/[0.06] bg-white/[0.04] px-4 py-3 text-[13px] text-white/85 placeholder:text-white/20 outline-none transition-all focus:border-white/[0.12] focus:bg-white/[0.06]"
                />
                {!canUseCustomApi && (
                  <p className="text-[11px] text-red-300/80">API Key is required</p>
                )}
              </>
            ) : (
              <p className="text-[11px] text-white/28">{DEFAULT_API_BASE}</p>
            )}
          </div>
        </div>

        {loading ? (
          <div className="flex flex-col items-center gap-4">
            <div className="w-10 h-10 rounded-full border-2 border-white/[0.06] border-t-accent animate-spin" />
            <p className="text-[12px] text-white/25">{t('auth.signingIn')}</p>
            {authUrl && (
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(authUrl);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-[11px] text-white/30 hover:text-white/50 transition-all cursor-pointer"
              >
                {copied ? (
                  <>
                    <Check size={12} />
                    {t('auth.copied')}
                  </>
                ) : (
                  <>
                    <ClipboardCopy size={12} />
                    {t('auth.copyLink')}
                  </>
                )}
              </button>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={handleLogin}
            disabled={!canUseCustomApi}
            className="w-full py-3.5 rounded-2xl bg-accent text-accent-contrast font-semibold text-sm hover:bg-accent-hover active:scale-[0.97] transition-all duration-200 ease-[var(--ease-apple)] cursor-pointer shadow-[0_0_40px_var(--color-accent-glow),0_4px_12px_rgba(0,0,0,0.3)] hover:shadow-[0_0_60px_var(--color-accent-glow),0_4px_16px_rgba(0,0,0,0.4)] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-accent disabled:active:scale-100 disabled:hover:shadow-[0_0_40px_var(--color-accent-glow),0_4px_12px_rgba(0,0,0,0.3)]"
          >
            {t('auth.signIn')}
          </button>
        )}
      </div>
    </div>
  );
}
