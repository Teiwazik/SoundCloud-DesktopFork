import * as Dialog from '@radix-ui/react-dialog';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { art, fc } from '../../lib/formatters';
import {
  type Playlist,
  useAddToPlaylist,
  useCreatePlaylist,
  useMyPlaylists,
} from '../../lib/hooks';
import { Globe, ListMusic, ListPlus, Loader2, Lock, Plus, X } from '../../lib/icons';

interface AddToPlaylistDialogProps {
  trackUrn?: string;
  trackUrns?: string[];
  children: React.ReactNode;
}

const PlaylistOption = React.memo(function PlaylistOption({
  playlist,
  onSelect,
  loading,
}: {
  playlist: Playlist;
  onSelect: (p: Playlist) => void;
  loading: boolean;
}) {
  const cover = art(playlist.artwork_url ?? playlist.tracks?.[0]?.artwork_url, 'small');

  return (
    <button
      type="button"
      onClick={() => onSelect(playlist)}
      disabled={loading}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/[0.06] transition-all duration-200 text-left disabled:opacity-50"
    >
      <div className="w-10 h-10 rounded-lg overflow-hidden shrink-0 ring-1 ring-white/[0.06] bg-white/[0.03]">
        {cover ? (
          <img src={cover} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <ListMusic size={14} className="text-white/20" />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium text-white/85 truncate">{playlist.title}</p>
        <p className="text-[11px] text-white/30">{fc(playlist.track_count)} tracks</p>
      </div>
      {playlist.sharing === 'private' && <Lock size={12} className="text-white/20 shrink-0" />}
    </button>
  );
});

/* ── Inline Create Form ──────────────────────────────────────── */

const CreatePlaylistForm = React.memo(function CreatePlaylistForm({
  trackUrns,
  onCreated,
}: {
  trackUrns: string[];
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const createPlaylist = useCreatePlaylist();

  const handleSubmit = useCallback(() => {
    const title = name.trim();
    if (!title) return;
    createPlaylist.mutate(
      { title, sharing: isPrivate ? 'private' : 'public', trackUrns },
      {
        onSuccess: () => {
          toast.success(t('playlist.created'));
          onCreated();
        },
      },
    );
  }, [name, isPrivate, trackUrns, createPlaylist, onCreated, t]);

  return (
    <div className="px-3 pb-3">
      <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-3 space-y-2.5">
        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          placeholder={t('playlist.playlistName')}
          className="w-full bg-white/[0.04] text-[13px] text-white/90 placeholder:text-white/25 px-3 py-2 rounded-lg outline-none border border-white/[0.06] focus:border-accent/30 transition-colors"
          autoFocus
          disabled={createPlaylist.isPending}
        />
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setIsPrivate((v) => !v)}
            className="flex items-center gap-1.5 text-[11px] text-white/40 hover:text-white/60 transition-colors cursor-pointer"
          >
            {isPrivate ? <Lock size={12} /> : <Globe size={12} />}
            {isPrivate ? t('playlist.private') : t('playlist.public')}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!name.trim() || createPlaylist.isPending}
            className="px-3.5 py-1.5 rounded-lg text-[12px] font-semibold bg-accent text-accent-contrast hover:bg-accent-hover disabled:opacity-40 transition-all cursor-pointer disabled:cursor-not-allowed"
          >
            {createPlaylist.isPending ? t('playlist.creating') : t('playlist.create')}
          </button>
        </div>
      </div>
    </div>
  );
});

/* ── Main Dialog ─────────────────────────────────────────────── */

export const AddToPlaylistDialog = React.memo(function AddToPlaylistDialog({
  trackUrn,
  trackUrns,
  children,
}: AddToPlaylistDialogProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const normalizedTrackUrns = useMemo(() => {
    if (trackUrn) return [trackUrn];
    return trackUrns ?? [];
  }, [trackUrn, trackUrns]);
  const { playlists, isLoading } = useMyPlaylists(30, open);
  const addToPlaylist = useAddToPlaylist();

  const handleSelect = async (playlist: Playlist) => {
    const existingUrns = playlist.tracks?.map((t) => t.urn) ?? [];

    // Fetch full track list if not embedded
    let finalExistingUrns = existingUrns;
    if (existingUrns.length === 0 && playlist.track_count > 0) {
      try {
        const res = await api<{ collection: { urn: string }[] }>(
          `/playlists/${encodeURIComponent(playlist.urn)}/tracks?limit=200`,
        );
        finalExistingUrns = res.collection.map((t) => t.urn);
      } catch {
        finalExistingUrns = [];
      }
    }

    // Filter out duplicates
    const existingSet = new Set(finalExistingUrns);
    const newUrns = normalizedTrackUrns.filter((u) => !existingSet.has(u));

    if (newUrns.length === 0) {
      toast.info('Already in playlist');
      setOpen(false);
      return;
    }

    addToPlaylist.mutate(
      { playlistUrn: playlist.urn, existingTrackUrns: finalExistingUrns, newTrackUrns: newUrns },
      {
        onSuccess: () => {
          toast.success(t('playlist.addedToPlaylist'));
          setOpen(false);
        },
      },
    );
  };

  const handleOpenChange = (v: boolean) => {
    setOpen(v);
    if (!v) setShowCreate(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Trigger asChild>{children}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[70] animate-fade-in" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[70] w-[380px] max-h-[70vh] rounded-2xl glass border border-white/[0.08] shadow-2xl animate-fade-in-up flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-5 pt-5 pb-3">
            <Dialog.Title className="text-[15px] font-bold text-white/90 flex items-center gap-2">
              <ListPlus size={18} />
              {t('playlist.addToPlaylist')}
            </Dialog.Title>
            <Dialog.Close className="w-7 h-7 rounded-lg flex items-center justify-center text-white/30 hover:text-white/70 hover:bg-white/[0.08] transition-all">
              <X size={14} />
            </Dialog.Close>
          </div>

          {/* New playlist button / form */}
          {showCreate ? (
              <CreatePlaylistForm
               trackUrns={normalizedTrackUrns}
               onCreated={() => {
                 setShowCreate(false);
                 setOpen(false);
              }}
            />
          ) : (
            <div className="px-3 pb-2">
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/[0.06] transition-all duration-200 text-left"
              >
                <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-accent/10 ring-1 ring-accent/20">
                  <Plus size={18} className="text-accent" />
                </div>
                <span className="text-[13px] font-medium text-accent">
                  {t('playlist.newPlaylist')}
                </span>
              </button>
            </div>
          )}

          {/* Divider */}
          <div className="h-px bg-white/[0.04] mx-5" />

          {/* Playlist list */}
          <div className="px-3 py-2 pb-4 overflow-y-auto flex-1 min-h-0">
            {isLoading ? (
              <div className="flex justify-center py-10">
                <Loader2 size={20} className="animate-spin text-white/20" />
              </div>
            ) : playlists.length === 0 ? (
              <div className="py-10 text-center text-[13px] text-white/25">
                {t('playlist.noPlaylists')}
              </div>
            ) : (
              <div className="space-y-0.5">
                {playlists.map((p) => (
                  <PlaylistOption
                    key={p.urn}
                    playlist={p}
                    onSelect={handleSelect}
                    loading={addToPlaylist.isPending}
                  />
                ))}
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
});
