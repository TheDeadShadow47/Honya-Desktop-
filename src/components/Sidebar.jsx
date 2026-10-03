import icon from '@assets/icon.png';
import Icon from './Icon.jsx';
import { go } from '../lib/router';
import { useI18n } from '../lib/settings.jsx';
import { useUnreadCount } from '../lib/useLibrary.js';

const ITEMS = [
  { id: 'library', key: 'nav.library', icon: 'library' },
  { id: 'updates', key: 'nav.updates', icon: 'updates' },
  { id: 'history', key: 'nav.history', icon: 'history' },
  { id: 'catalogs', key: 'nav.catalogs', icon: 'catalogs' },
  { id: 'downloads', key: 'downloads.title', icon: 'downloads' },
  { id: 'settings', key: 'settings.title', icon: 'settings' },
];

export default function Sidebar({ active }) {
  const t = useI18n();
  const { queueCount, unreadChapters } = useUnreadCount();

  const badgeFor = (id) => {
    if (id === 'downloads' && queueCount > 0) return queueCount;
    if (id === 'updates' && unreadChapters > 0) return unreadChapters;
    return null;
  };

  return (
    <nav className="sidebar" aria-label={t('nav.library')}>
      <div className="brand">
        <img src={icon} alt="" />
        <span>Honya</span>
      </div>
      <div className="nav-group">
        {ITEMS.map((it) => {
          const count = badgeFor(it.id);
          return (
            <button
              key={it.id}
              className={`nav-item ${active === it.id ? 'active' : ''}`}
              onClick={() => go(it.id)}
              aria-current={active === it.id ? 'page' : undefined}
              title={t(it.key)}
            >
              <Icon name={it.icon} className="nav-icon" />
              <span className="nav-label">{t(it.key)}</span>
              {count != null && <span className="nav-badge">{count > 99 ? '99+' : count}</span>}
            </button>
          );
        })}
      </div>
      <div className="nav-spacer" />
    </nav>
  );
}