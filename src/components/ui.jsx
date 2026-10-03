import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { go } from '../lib/router';
import { useI18n } from '../lib/settings.jsx';

export const Empty = ({ icon = 'library', title, hint, children }) => {
  const t = useI18n();
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={icon} size={44} strokeWidth={1.3} />
      </div>
      <h3>{title}</h3>
      {hint && <p>{hint}</p>}
      {children}
    </div>
  );
};

export const ErrorBox = ({ error, onRetry }) => {
  const t = useI18n();
  return (
    <div className="errorbox" role="alert">
      <Icon name="alert" size={18} />
      <div className="grow">
        <strong>{t('reader.couldNotLoad')}</strong>
        <span>{String(error?.message ?? error)}</span>
      </div>
      {onRetry && (
        <button className="btn small" onClick={onRetry}>
          <Icon name="refresh" size={14} /> {t('common.retry')}
        </button>
      )}
    </div>
  );
};

export const Spinner = ({ size = 18 }) => (
  <span className="spinner" style={{ width: size, height: size }} role="progressbar" aria-busy="true" />
);

export const Cover = ({ src, title, className = '' }) =>
  src ? (
    <img
      className={`cover ${className}`}
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={(e) => {
        e.currentTarget.style.visibility = 'hidden';
      }}
    />
  ) : (
    <div className={`cover cover-ph ${className}`}>{(title || '?').slice(0, 1).toUpperCase()}</div>
  );

export const Header = ({ title, subtitle, children }) => (
  <header className="page-header">
    <div className="page-titles">
      <h1>{title}</h1>
      {subtitle && <p className="muted">{subtitle}</p>}
    </div>
    {children && <div className="page-actions">{children}</div>}
  </header>
);

export const Button = ({ icon, children, kind, ...rest }) => (
  <button className={`btn ${kind ? `btn-${kind}` : ''}`} {...rest}>
    {icon && <Icon name={icon} size={15} />}
    {children}
  </button>
);

export const IconButton = ({ icon, label, active, ...rest }) => (
  <button
    className={`icon-btn ${active ? 'on' : ''}`}
    title={label}
    aria-label={label}
    aria-pressed={active === undefined ? undefined : !!active}
    {...rest}
  >
    <Icon name={icon} size={17} />
  </button>
);

export const Segmented = ({ value, onChange, options }) => (
  <div className="seg" role="group">
    {options.map((o) => (
      <button
        key={o.value}
        className={value === o.value ? 'on' : ''}
        onClick={() => onChange(o.value)}
        aria-pressed={value === o.value}
        title={o.label}
      >
        {o.icon && <Icon name={o.icon} size={14} />}
        {o.label}
      </button>
    ))}
  </div>
);

export const Checkbox = ({ checked, onChange, label, hint, disabled }) => (
  <label className="check">
    <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    <span>
      {label}
      {hint && <small className="muted">{hint}</small>}
    </span>
  </label>
);

export const Field = ({ label, hint, children }) => (
  <label className="field">
    <span className="field-label">
      {label}
      {hint && <small>{hint}</small>}
    </span>
    {children}
  </label>
);

export const Select = ({ value, onChange, options, ...rest }) => (
  <select className="input" value={value} onChange={(e) => onChange(e.target.value)} {...rest}>
    {options.map((o) => (
      <option key={o.value} value={o.value}>
        {o.label}
      </option>
    ))}
  </select>
);

/** Desktop modal dialog. Focus-trapped, Escape-closable, direction-aware. */
export function Dialog({ open, title, children, onClose, footer, width = 520 }) {
  const box = useRef(null);
  const t = useI18n();
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
      }
    };
    document.addEventListener('keydown', onKey, true);
    box.current?.querySelector('button, input, select, textarea')?.focus();
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="dialog" style={{ width }} role="dialog" aria-modal="true" aria-label={title} ref={box}>
        {title && (
          <div className="dialog-head">
            <h3>{title}</h3>
            <IconButton icon="close" label={t('common.close')} onClick={onClose} />
          </div>
        )}
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** Transient status message shown in the corner; replaces the notification-only feedback loop. */
export function useToast() {
  const [toast, setToast] = useState(null);
  const timer = useRef(null);
  const show = useCallback((text, kind = 'info') => {
    setToast({ text, kind });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 4000);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  const node = toast ? (
    <div className={`toast ${toast.kind}`} role="status">
      {toast.text}
    </div>
  ) : null;
  return { show, node };
}

export const openChapter = (c) => go('reader', c.id);
export const openNovel = (n) => go('novel', n.id ?? n.novelId);

/** "3m ago" style label. Kept locale-neutral; the surrounding UI carries the language. */
export const ago = (ts) => {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 2592000) return `${Math.round(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
};

export const pct = (p) => `${Math.round((Number(p) || 0) * 100)}%`;

/** Chapter status glyph: unread dot, in-progress ring, or finished check. */
export const ChapterState = ({ chapter }) => {
  const t = useI18n();
  const title = chapter.read
    ? t('historyRow.finished')
    : chapter.progress > 0
      ? t('historyRow.readPct', { pct: Math.round(chapter.progress * 100) })
      : t('chapter.unreadLabel');
  return (
    <span className={`chap-state ${chapter.read ? 'read' : chapter.progress > 0 ? 'reading' : 'unread'}`} title={title}>
      {chapter.read ? <Icon name="check" size={13} /> : chapter.progress > 0 ? <span className="ring" /> : <span className="dot" />}
    </span>
  );
};