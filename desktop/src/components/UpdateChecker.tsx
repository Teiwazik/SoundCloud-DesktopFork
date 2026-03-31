import { fetch } from '@tauri-apps/plugin-http';
import { check } from '@tauri-apps/plugin-updater';
import { isTauri } from '@tauri-apps/api/core';
import { relaunch } from '@tauri-apps/plugin-process';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ExternalLink, Sparkles, X } from '../lib/icons';
import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import { APP_VERSION, GITHUB_OWNER, GITHUB_REPO, GITHUB_REPO_EN } from '../lib/constants';
import i18n from '../i18n';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

interface GithubRelease {
  tag_name: string;
  name: string;
  body: string;
  html_url: string;
  published_at: string;
}

function stripLeadingV(version: string) {
  return version.replace(/^v/, '');
}

async function fetchRelease(repo: string): Promise<GithubRelease | null> {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${repo}/releases/latest`;
  const r = await fetch(url);
  return r.ok ? r.json() : null;
}

export function UpdateChecker() {
  const { t } = useTranslation();
  const [release, setRelease] = useState<GithubRelease | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  useEffect(() => {
    fetchRelease(GITHUB_REPO)
      .then(async (ru) => {
        if (!ru) return;
        const latest = stripLeadingV(ru.tag_name);
        const current = stripLeadingV(APP_VERSION);
        if (latest === current) return;

        const isEn = !i18n.language?.startsWith('ru');
        if (isEn) {
          const en = await fetchRelease(GITHUB_REPO_EN).catch(() => null);
          if (en && stripLeadingV(en.tag_name) === latest) {
            setRelease(en);
            return;
          }
        }
        setRelease(ru);
      })
      .catch(() => {});
  }, []);

  const handleUpdate = async () => {
    if (!release || updating) return;

    if (!isTauri()) {
      await openUrl(release.html_url);
      return;
    }

    setUpdateError(null);
    setUpdating(true);
    setDownloadProgress(null);

    try {
      const update = await check();
      if (!update) {
        setDismissed(true);
        return;
      }

      let downloaded = 0;
      let contentLength = 0;

      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          contentLength = event.data.contentLength ?? 0;
          setDownloadProgress(contentLength > 0 ? 0 : null);
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          if (contentLength > 0) {
            setDownloadProgress(Math.min(100, Math.round((downloaded / contentLength) * 100)));
          }
        } else if (event.event === 'Finished') {
          setDownloadProgress(100);
        }
      });

      await relaunch();
    } catch (e) {
      console.error('Auto update failed', e);
      const msg = t('update.failed');
      setUpdateError(msg);
      toast.error(msg);
      setUpdating(false);
    }
  };

  if (!release || dismissed) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative w-full max-w-md mx-4 rounded-2xl bg-[#1a1a1e]/95 backdrop-blur-2xl border border-white/[0.12] shadow-[0_8px_64px_rgba(0,0,0,0.6)] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-accent/15 flex items-center justify-center">
              <Sparkles size={16} className="text-accent" />
            </div>
            <div>
              <h2 className="text-sm font-semibold">{t('update.available')}</h2>
              <p className="text-[11px] text-white/30 mt-0.5">
                {stripLeadingV(APP_VERSION)} → {stripLeadingV(release.tag_name)}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="w-7 h-7 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] flex items-center justify-center transition-colors cursor-pointer"
          >
            <X size={14} className="text-white/40" />
          </button>
        </div>

        {/* Release title */}
        {release.name && (
          <div className="px-5 pb-2">
            <p className="text-[13px] font-medium text-white/80">{release.name}</p>
          </div>
        )}

        {/* Release notes */}
        {release.body && (
          <div className="mx-5 mb-4 max-h-60 overflow-y-auto rounded-xl bg-black/30 border border-white/[0.08] p-4 prose prose-invert prose-sm max-w-none prose-p:text-white/60 prose-p:text-[12px] prose-p:leading-relaxed prose-headings:text-white/80 prose-headings:text-[13px] prose-headings:mt-3 prose-headings:mb-1 prose-strong:text-white/70 prose-a:text-accent prose-a:no-underline hover:prose-a:underline prose-li:text-white/60 prose-li:text-[12px] prose-code:text-accent/80 prose-code:text-[11px] prose-code:bg-white/[0.06] prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-img:rounded-lg prose-img:max-w-full prose-hr:border-white/[0.08]">
            <Markdown>{release.body}</Markdown>
          </div>
        )}

        {/* Actions */}
        {updateError && (
          <div className="px-5 pb-2">
            <p className="text-[11px] text-red-300/80">{updateError}</p>
          </div>
        )}
        {updating && (
          <div className="px-5 pb-2">
            <p className="text-[11px] text-white/45">
              {downloadProgress != null
                ? t('update.downloadingProgress', { progress: downloadProgress })
                : t('update.installing')}
            </p>
          </div>
        )}
        <div className="flex gap-2 px-5 pb-5">
          <button
            type="button"
            onClick={() => setDismissed(true)}
            disabled={updating}
            className="flex-1 py-2.5 rounded-xl bg-white/[0.05] hover:bg-white/[0.08] text-[13px] text-white/50 font-medium transition-colors cursor-pointer"
          >
            {t('update.later')}
          </button>
          <button
            type="button"
            onClick={() => void handleUpdate()}
            disabled={updating}
            className="flex-1 py-2.5 rounded-xl bg-accent hover:bg-accent-hover text-[13px] text-accent-contrast font-semibold transition-colors cursor-pointer flex items-center justify-center gap-1.5 shadow-[0_0_20px_var(--color-accent-glow)]"
          >
            {updating ? t('update.installing') : t('update.download')}
            {!updating && <ExternalLink size={13} />}
          </button>
        </div>
      </div>
    </div>
  );
}
