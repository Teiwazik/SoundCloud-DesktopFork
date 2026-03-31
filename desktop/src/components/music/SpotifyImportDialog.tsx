import * as Dialog from '@radix-ui/react-dialog';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { api, getSessionId } from '../../lib/api';
import { getApiBase } from '../../lib/constants';
import { Loader2, X } from '../../lib/icons';
import { useSettingsStore } from '../../stores/settings';

interface ImportProgress {
  total: number;
  current: number;
  found: number;
  not_found: number;
  current_track: string;
}

interface ScPlaylist {
  urn: string;
  title: string;
  track_count: number;
  artwork_url: string | null;
  permalink_url: string;
  user: { username: string };
}

const PLAYLIST_NAME = 'Spotify Likes';

export function SpotifyImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const clientId = useSettingsStore((s) => s.spotifyClientId);
  const setClientId = useSettingsStore((s) => s.setSpotifyClientId);

  const [authed, setAuthed] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [done, setDone] = useState(false);
  const [playlist, setPlaylist] = useState<ScPlaylist | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Check auth state on mount
  useEffect(() => {
    invoke<boolean>('spotify_is_authed').then(setAuthed).catch(() => {});
  }, [open]);

  // Listen for auth + progress events
  useEffect(() => {
    let unlistenAuthed: (() => void) | null = null;
    let unlistenLogout: (() => void) | null = null;
    let unlistenProgress: (() => void) | null = null;

    listen('spotify:authed', () => { setAuthed(true); setSigningIn(false); })
      .then((fn) => { unlistenAuthed = fn; });
    listen('spotify:logged_out', () => { setAuthed(false); })
      .then((fn) => { unlistenLogout = fn; });
    listen<ImportProgress>('spotify_import:progress', (e) => setProgress(e.payload))
      .then((fn) => { unlistenProgress = fn; });

    return () => {
      unlistenAuthed?.();
      unlistenLogout?.();
      unlistenProgress?.();
    };
  }, []);

  const handleSignIn = useCallback(async () => {
    if (!clientId.trim()) {
      setError(t('importExternal.spotifyClientIdRequired'));
      return;
    }
    setError(null);
    setSigningIn(true);
    try {
      await invoke('spotify_auth_start', { clientId: clientId.trim() });
    } catch (e) {
      setError(String(e));
      setSigningIn(false);
    }
  }, [clientId, t]);

  const handleLogout = useCallback(() => {
    invoke('spotify_logout').catch(console.error);
    setAuthed(false);
    setDone(false);
    setProgress(null);
    setPlaylist(null);
  }, []);

  const findOrCreatePlaylist = useCallback(async (urns: string[]) => {
    setSaving(true);
    try {
      const res = await api<{ collection: ScPlaylist[] }>('/me/playlists?limit=200');
      const existing = res.collection.find((p) => p.title === PLAYLIST_NAME);
      const trackObjects = urns.map((urn) => ({ urn }));
      let result: ScPlaylist;
      if (existing) {
        result = await api<ScPlaylist>(`/playlists/${encodeURIComponent(existing.urn)}`, {
          method: 'PUT',
          body: JSON.stringify({ playlist: { tracks: trackObjects } }),
        });
      } else {
        result = await api<ScPlaylist>('/playlists', {
          method: 'POST',
          body: JSON.stringify({ playlist: { title: PLAYLIST_NAME, sharing: 'private', tracks: trackObjects } }),
        });
      }
      setPlaylist(result);
    } catch (e) {
      console.error('[Spotify Import] playlist save failed:', e);
    } finally {
      setSaving(false);
    }
  }, []);

  const handleStart = useCallback(async () => {
    setRunning(true);
    setDone(false);
    setProgress(null);
    setPlaylist(null);
    setError(null);
    try {
      const urns: string[] = await invoke('spotify_import_start', {
        backendUrl: getApiBase(),
        sessionId: getSessionId() || '',
      });
      setDone(true);
      setRunning(false);
      await findOrCreatePlaylist(urns);
    } catch (e) {
      setError(String(e));
      setRunning(false);
    }
  }, [findOrCreatePlaylist]);

  const handleStop = useCallback(() => {
    invoke('spotify_import_stop').catch(console.error);
    setRunning(false);
  }, []);

  const pct = progress && progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : 0;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[80] bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed z-[80] top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-[520px] bg-[#1a1a1e]/95 backdrop-blur-2xl border border-white/[0.08] rounded-3xl shadow-2xl overflow-hidden">
          {/* Header */}
          <div className="px-7 pt-6 pb-4 border-b border-white/[0.06] flex items-center justify-between">
            <Dialog.Title className="text-[18px] font-bold text-white/90 tracking-tight flex items-center gap-2">
              <span style={{ color: '#1db954' }}>▶</span> {t('importExternal.spotifyTitle')}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button className="w-8 h-8 rounded-lg flex items-center justify-center text-white/30 hover:text-white/60 hover:bg-white/[0.08] transition-all cursor-pointer">
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          {/* Body */}
          <div className="px-7 py-5 space-y-5">
            {error && (
              <div className="px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-[13px] text-red-400">
                {error}
              </div>
            )}

            {/* Playlist result */}
            {playlist ? (
              <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.03]">
                <div className="absolute inset-0 bg-gradient-to-br from-[#1db954]/10 via-transparent to-transparent" />
                <div className="relative p-5 flex items-center gap-4">
                  <div className="w-16 h-16 rounded-xl bg-[#1db954]/20 flex items-center justify-center shrink-0 text-2xl">
                    ♫
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[15px] font-bold text-white/90 truncate">{playlist.title}</p>
                    <p className="text-[12px] text-white/40 mt-0.5">
                      {t('importExternal.tracksImported', { count: progress?.found || 0 })}
                    </p>
                    <p className="text-[11px] text-[#1db954] mt-1">✓ {t('importExternal.done')}</p>
                  </div>
                  <button
                    onClick={() => { onOpenChange(false); navigate(`/playlist/${encodeURIComponent(playlist.urn)}`); }}
                    className="px-4 py-2 rounded-xl bg-[#1db954]/20 hover:bg-[#1db954]/30 text-[13px] font-semibold text-[#1db954] border border-[#1db954]/20 transition-all cursor-pointer shrink-0"
                  >
                    {t('importExternal.open')}
                  </button>
                </div>
              </div>
            ) : !authed ? (
              <>
                {/* Client ID setup */}
                <div className="space-y-2">
                  <p className="text-[13px] font-semibold text-white/70">
                    {t('importExternal.spotifyClientIdLabel')}
                  </p>
                  <p className="text-[12px] text-white/40">
                    {t('importExternal.spotifyClientIdHintBefore')}{' '}
                    <span className="text-[#1db954]">developer.spotify.com/dashboard</span>
                    {' '}{t('importExternal.spotifyClientIdHintAfter')}{' '}
                    <span className="text-white/60 font-mono text-[11px]">http://127.0.0.1:PORT/callback</span>
                    {' '}{t('importExternal.spotifyClientIdHintPort')}
                  </p>
                  <input
                    type="text"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    placeholder={t('importExternal.spotifyClientIdPlaceholder')}
                    className="w-full px-4 py-3 rounded-xl bg-white/[0.04] border border-white/[0.06] text-[13px] text-white/80 placeholder:text-white/20 focus:border-white/[0.12] focus:bg-white/[0.06] transition-all outline-none"
                  />
                </div>
              </>
            ) : (
              <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-[#1db954]/10 border border-[#1db954]/20">
                <span className="text-xl">✔</span>
                <div>
                  <p className="text-[13px] font-semibold text-[#1db954]">
                    {t('importExternal.spotifySignedIn')}
                  </p>
                  <p className="text-[11px] text-white/40">{t('importExternal.spotifyReady')}</p>
                </div>
                <button
                  onClick={handleLogout}
                  className="ml-auto text-[11px] text-white/30 hover:text-white/60 transition-colors cursor-pointer"
                >
                  {t('auth.signOut')}
                </button>
              </div>
            )}

            {/* Progress bar */}
            {progress && !playlist && (
              <div className="space-y-3">
                <div className="w-full h-2 rounded-full bg-white/[0.06] overflow-hidden">
                  <div className="h-full rounded-full bg-[#1db954] transition-all duration-300" style={{ width: `${pct}%` }} />
                </div>
                <div className="flex items-center justify-between text-[12px] text-white/40">
                  <span>{progress.current} / {progress.total}</span>
                  <span className="text-green-400">
                    {t('importExternal.found', { count: progress.found })}
                  </span>
                  <span className="text-red-400">
                    {t('importExternal.notFound', { count: progress.not_found })}
                  </span>
                </div>
                {progress.current_track && (
                  <p className="text-[12px] text-white/30 truncate">{progress.current_track}</p>
                )}
              </div>
            )}

            {saving && <p className="text-[13px] text-white/50 animate-pulse">{t('importExternal.savingPlaylist')}</p>}
          </div>

          {/* Footer */}
          {!playlist && (
            <div className="px-7 py-4 border-t border-white/[0.06] flex justify-end gap-3">
              {!authed ? (
                <button
                  onClick={handleSignIn}
                  disabled={signingIn}
                  className="flex items-center gap-2 px-5 py-2 rounded-xl bg-[#1db954]/20 hover:bg-[#1db954]/30 text-[13px] font-semibold text-[#1db954] border border-[#1db954]/20 transition-all cursor-pointer disabled:opacity-50"
                >
                  {signingIn && <Loader2 size={14} className="animate-spin" />}
                  {t('importExternal.spotifySignIn')}
                </button>
              ) : running ? (
                <button onClick={handleStop} className="px-5 py-2 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-[13px] font-semibold text-red-400 border border-red-500/10 cursor-pointer">
                  {t('importExternal.stopImport')}
                </button>
              ) : (
                <button
                  onClick={handleStart}
                  disabled={done}
                  className="px-5 py-2 rounded-xl bg-[#1db954]/20 hover:bg-[#1db954]/30 text-[13px] font-semibold text-[#1db954] border border-[#1db954]/20 transition-all cursor-pointer disabled:opacity-30"
                >
                  {t('importExternal.startImport')}
                </button>
              )}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default SpotifyImportDialog;
