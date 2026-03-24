import React from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { Home, Library, Search, Settings } from '../lib/icons';

export const MobileNav = React.memo(() => {
  const { t } = useTranslation();

  const items = [
    { to: '/', icon: Home, label: 'nav.home' },
    { to: '/search', icon: Search, label: 'nav.search' },
    { to: '/library', icon: Library, label: 'nav.library' },
    { to: '/settings', icon: Settings, label: 'nav.settings' },
  ];

  return (
    <nav className="flex items-center justify-around h-16 bg-black/60 backdrop-blur-xl border-t border-white/[0.04] px-2 pb-safe">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) =>
            `flex flex-col items-center gap-1 transition-colors ${
              isActive ? 'text-accent' : 'text-white/40'
            }`
          }
        >
          <item.icon size={20} strokeWidth={2} />
          <span className="text-[10px] font-medium">{t(item.label)}</span>
        </NavLink>
      ))}
    </nav>
  );
});
