import React from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { useShallow } from 'zustand/shallow';
import { art } from '../../lib/formatters';
import {
  Clock,
  Download,
  Globe,
  Home,
  Library,
  ListMusic,
  MapPin,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
} from '../../lib/icons';
import { useAppStatusStore } from '../../stores/app-status';
import { useAuthStore } from '../../stores/auth';
import { useSettingsStore } from '../../stores/settings';
import { Avatar } from '../ui/Avatar';
import { StarBadge, StarCard, StarModal, useStarSubscription } from './StarSubscription';

const languages = [
  { code: 'en', label: 'English' },
  { code: 'ru', label: 'Русский' },
  { code: 'tr', label: 'Turkce' },
] as const;

const navItems = [
  { to: '/', icon: Home, label: 'nav.home' },
  { to: '/search', icon: Search, label: 'nav.search' },
  { to: '/library', icon: Library, label: 'nav.library' },
  { to: '/offline', icon: Download, label: 'nav.offline' },
];

export const Sidebar = React.memo(() => {
  const { t, i18n } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const appMode = useAppStatusStore((s) =>
    s.soundcloudBlocked
      ? 'blocked'
      : !s.navigatorOnline || !s.backendReachable
        ? 'offline'
        : 'online',
  );
  const { collapsed, pinnedPlaylists, toggleSidebar } = useSettingsStore(
    useShallow((s) => ({
      collapsed: s.sidebarCollapsed,
      pinnedPlaylists: s.pinnedPlaylists,
      toggleSidebar: s.toggleSidebar,
    })),
  );
  const { isPremium, modalOpen, setModalOpen, openModal } = useStarSubscription();

  const toggleLanguage = () => {
    const next = i18n.language === 'ru' ? 'en' : 'ru';
    i18n.changeLanguage(next);
  };

  const currentLang = languages.find((l) => l.code === i18n.language) ?? languages[0];

  return (
    <aside
      className="shrink-0 flex flex-col h-full border-r border-white/[0.04] transition-[width] duration-200 ease-[var(--ease-apple)]"
      style={{ width: collapsed ? 56 : 200 }}
    >
      <nav className="flex flex-col gap-0.5 px-2 pt-2">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            title={collapsed ? t(item.label) : undefined}
            className={({ isActive }) => {
              let stateClass = 'text-white/40 hover:text-white/70 hover:bg-white/[0.04]';
              if (isActive) {
                stateClass =
                  'text-white bg-white/[0.07] shadow-[inset_0_0.5px_0_rgba(255,255,255,0.1)]';
              } else if (item.to === '/offline' && appMode !== 'online') {
                stateClass = 'text-white/82 bg-accent/[0.08] ring-1 ring-accent/15';
              }

              return `flex items-center gap-3 rounded-xl text-[13px] font-medium transition-all duration-200 ease-[var(--ease-apple)] ${
                collapsed ? 'justify-center px-0 py-2.5' : 'px-3 py-2.5'
              } ${stateClass}`;
            }}
          >
            <item.icon size={18} strokeWidth={1.8} />
            {!collapsed && t(item.label)}
          </NavLink>
        ))}
      </nav>

      <div className="px-2 pt-4 space-y-1">
        {!collapsed && (
          <div className="px-3 pb-1 flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-white/20 font-semibold">
            <MapPin size={11} strokeWidth={1.8} />
            {t('sidebar.quickAccess')}
          </div>
        )}

        <NavLink
          to="/library?tab=history"
          title={collapsed ? t('library.history') : undefined}
          className={({ isActive }) =>
            `flex items-center gap-2.5 w-full rounded-xl text-[12px] font-medium transition-all duration-200 ${
              collapsed ? 'justify-center px-0 py-2.5' : 'px-3 py-2.5'
            } ${
              isActive
                ? 'text-white bg-white/[0.07]'
                : 'text-white/40 hover:text-white/70 hover:bg-white/[0.04]'
            }`
          }
        >
          <Clock size={16} strokeWidth={1.8} />
          {!collapsed && <span className="truncate">{t('library.history')}</span>}
        </NavLink>

        {pinnedPlaylists.map((playlist) => {
          const artwork = art(playlist.artworkUrl, 'small');

          return (
            <NavLink
              key={playlist.urn}
              to={`/playlist/${encodeURIComponent(playlist.urn)}`}
              title={collapsed ? playlist.title : undefined}
              className={({ isActive }) =>
                `flex items-center gap-2.5 w-full rounded-xl text-[12px] font-medium transition-all duration-200 ${
                  collapsed ? 'justify-center px-0 py-2.5' : 'px-3 py-2.5'
                } ${
                  isActive
                    ? 'text-white bg-white/[0.07]'
                    : 'text-white/40 hover:text-white/70 hover:bg-white/[0.04]'
                }`
              }
            >
              {artwork ? (
                <img
                  src={artwork}
                  alt=""
                  className="w-4 h-4 rounded-[4px] object-cover shrink-0 ring-1 ring-white/[0.08]"
                  decoding="async"
                  loading="lazy"
                />
              ) : (
                <ListMusic size={16} strokeWidth={1.8} />
              )}
              {!collapsed && <span className="truncate">{playlist.title}</span>}
            </NavLink>
          );
        })}
      </div>

      <div className="flex-1" />

      <div className="px-2 pb-1 flex flex-col gap-0.5">
        {isAuthenticated && (
          <StarCard collapsed={collapsed} isPremium={isPremium} onOpenModal={openModal} />
        )}
        {/* Toggle sidebar */}
        <button
          type="button"
          onClick={toggleSidebar}
          title={collapsed ? t('nav.expand') : undefined}
          className={`flex items-center gap-2.5 w-full px-3 py-2 rounded-xl text-[12px] font-medium text-white/40 hover:text-white/70 hover:bg-white/[0.04] transition-all duration-200 cursor-pointer ${collapsed ? 'justify-center' : ''}`}
        >
          {collapsed ? (
            <PanelLeftOpen size={16} strokeWidth={1.8} />
          ) : (
            <PanelLeftClose size={16} strokeWidth={1.8} />
          )}
          {!collapsed && <span className="truncate">{t('nav.collapse')}</span>}
        </button>
        <button
          type="button"
          onClick={toggleLanguage}
          title={collapsed ? currentLang.label : undefined}
          className={`flex items-center gap-2.5 w-full px-3 py-2 rounded-xl text-[12px] font-medium text-white/40 hover:text-white/70 hover:bg-white/[0.04] transition-all duration-200 cursor-pointer ${collapsed ? 'justify-center' : ''}`}
        >
          <Globe size={16} strokeWidth={1.8} />
          {!collapsed && <span className="truncate">{currentLang.label}</span>}
        </button>
        <NavLink
          to="/settings"
          title={collapsed ? t('nav.settings') : undefined}
          className={({ isActive }) =>
            `flex items-center gap-2.5 w-full px-3 py-2 rounded-xl text-[12px] font-medium transition-all duration-200 ${
              collapsed ? 'justify-center' : ''
            } ${
              isActive
                ? 'text-white/70 bg-white/[0.07]'
                : 'text-white/40 hover:text-white/70 hover:bg-white/[0.04]'
            }`
          }
        >
          <Settings size={16} strokeWidth={1.8} />
          {!collapsed && <span className="truncate">{t('nav.settings')}</span>}
        </NavLink>
      </div>

      {user && (
        <div className="px-2 pb-3">
          <NavLink
            to={`/user/${encodeURIComponent(user.urn)}`}
            title={collapsed ? user.username : undefined}
            className={({ isActive }) =>
              `flex items-center gap-2.5 px-2 py-2.5 rounded-xl transition-all duration-200 cursor-pointer ${
                collapsed ? 'justify-center' : ''
              } ${
                isActive
                  ? 'bg-white/[0.07] shadow-[inset_0_0.5px_0_rgba(255,255,255,0.1)]'
                  : 'hover:bg-white/[0.04]'
              }`
            }
          >
            <Avatar src={user.avatar_url} alt={user.username} size={26} />
            {!collapsed && (
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-[12px] text-white/40 truncate font-medium">
                  {user.username}
                </span>
                {isPremium && <StarBadge />}
              </div>
            )}
          </NavLink>
        </div>
      )}
      <StarModal open={modalOpen} onOpenChange={setModalOpen} />
    </aside>
  );
});
