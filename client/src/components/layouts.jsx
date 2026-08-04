// App shells: InvestorLayout (top bar + bottom tab bar on mobile, side rail on
// desktop) and AdminLayout (Administrator Console sidebar per BPD Section 6.1).
// On phones both nav rails collapse into a hamburger-opened slide-in drawer.
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { useNotifications, FeedBadge, useLivePrices } from './market';

// "Install app" — offers the PWA install prompt (Android/desktop Chrome/Edge).
// The event is captured early in index.html; we just surface a button for it.
function InstallButton() {
  const [ready, setReady] = useState(typeof window !== 'undefined' && window.__bipReady);
  useEffect(() => {
    const on = () => setReady(true);
    window.addEventListener('bip-available', on);
    window.addEventListener('appinstalled', () => setReady(false));
    return () => window.removeEventListener('bip-available', on);
  }, []);
  if (!ready) return null;
  const install = async () => {
    const e = window.__bip; if (!e) return;
    e.prompt(); await e.userChoice; window.__bip = null; setReady(false);
  };
  return <button type="button" className="btn btn-primary btn-sm" onClick={install}>⤓ Install app</button>;
}

function Hamburger({ onClick }) {
  return (
    <button type="button" className="hamburger" aria-label="Open menu" onClick={onClick}>☰</button>
  );
}

function Logo({ to }) {
  return (
    <NavLink to={to} className="logo">
      <span className="logo-mark" aria-hidden>FV</span>
      <span className="logo-text">FIN<b>VORA</b></span>
    </NavLink>
  );
}

function Bell({ to }) {
  const { unread } = useNotifications();
  const nav = useNavigate();
  return (
    <button type="button" className="bell" onClick={() => nav(to)} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
      🔔{unread > 0 && <span className="bell-count">{unread > 99 ? '99+' : unread}</span>}
    </button>
  );
}

// Light / dark theme switch. The initial theme is set in index.html before paint;
// here we just flip <html data-theme> and remember the choice.
function ThemeToggle() {
  const [theme, setTheme] = useState(
    () => (typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme')) || 'dark',
  );
  const toggle = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('finvora-theme', next); } catch { /* storage blocked — ignore */ }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', next === 'light' ? '#ffffff' : '#0c0c0e');
    setTheme(next);
  };
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
      title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
    >
      {theme === 'light' ? '🌙' : '☀️'}
    </button>
  );
}

const I_NAV = [
  { to: '/app', label: 'Home', icon: '🏠', end: true },
  { to: '/app/markets', label: 'Markets', icon: '📊' },
  { to: '/app/trade', label: 'Stocks', icon: '📈' },
  { to: '/app/fno', label: 'F&O', icon: '🎯' },
  { to: '/app/ipo', label: 'IPO', icon: '🚀' },
  { to: '/app/portfolio', label: 'Portfolio', icon: '💼' },
  { to: '/app/orders', label: 'Orders', icon: '🧾' },
  { to: '/app/funds', label: 'Funds', icon: '💰' },
  { to: '/app/withdraw', label: 'Withdraw', icon: '🏦' },
  { to: '/app/transactions', label: 'History', icon: '📒' },
];
// Mobile bottom bar shows a focused subset (the drawer gives the full list).
const I_TABS = [
  { to: '/app', label: 'Home', icon: '🏠', end: true },
  { to: '/app/markets', label: 'Markets', icon: '📊' },
  { to: '/app/trade', label: 'Stocks', icon: '📈' },
  { to: '/app/fno', label: 'F&O', icon: '🎯' },
  { to: '/app/portfolio', label: 'Portfolio', icon: '💼' },
];

export function InvestorLayout() {
  const { user, logout } = useAuth();
  const { health, asOf } = useLivePrices();
  const [menuOpen, setMenuOpen] = useState(false);
  const close = () => setMenuOpen(false);
  return (
    <div className="shell">
      <header className="topbar">
        <Hamburger onClick={() => setMenuOpen(true)} />
        <Logo to="/app" />
        <div className="topbar-center"><FeedBadge health={health} asOf={asOf} /></div>
        <div className="topbar-right">
          <ThemeToggle />
          <InstallButton />
          <Bell to="/app/notifications" />
          <div className="user-chip" title={user?.email}>
            <span className="user-avatar">{(user?.email || 'U')[0].toUpperCase()}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={logout}>Logout</button>
          </div>
        </div>
      </header>
      <div className="shell-body">
        {menuOpen && <div className="nav-overlay" onClick={close} />}
        <nav className={`siderail${menuOpen ? ' open' : ''}`} aria-label="Main">
          {I_NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className="rail-link" onClick={close}>
              <span aria-hidden>{n.icon}</span>{n.label}
            </NavLink>
          ))}
        </nav>
        <main className="content"><Outlet /></main>
      </div>
      <nav className="tabbar" aria-label="Main">
        {I_TABS.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className="tab-link">
            <span className="tab-icon" aria-hidden>{n.icon}</span>{n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

const A_NAV = [
  { to: '/admin', label: 'Dashboard', icon: '📊', end: true },
  { to: '/admin/notifications', label: 'Notification Centre', icon: '🔔' },
  { to: '/admin/investors', label: 'Investors', icon: '👥' },
  { to: '/admin/kyc', label: 'KYC Approvals', icon: '🪪' },
  { to: '/admin/bank', label: 'Bank Approvals', icon: '🏦' },
  { to: '/admin/deposits', label: 'Deposits', icon: '💰' },
  { to: '/admin/orders', label: 'Trade Execution', icon: '⚡' },
  { to: '/admin/withdrawals', label: 'Withdrawals', icon: '📤' },
  { to: '/admin/reports', label: 'Reports', icon: '📑' },
  { to: '/admin/password-resets', label: 'Password Resets', icon: '🔑' },
  { to: '/admin/feed', label: 'Feed Monitor', icon: '📡' },
  { to: '/admin/settings', label: 'Settings', icon: '⚙️' },
];

export function AdminLayout() {
  const { user, logout } = useAuth();
  const { health, asOf } = useLivePrices();
  const [menuOpen, setMenuOpen] = useState(false);
  const close = () => setMenuOpen(false);
  return (
    <div className="shell shell-admin">
      <header className="topbar">
        <Hamburger onClick={() => setMenuOpen(true)} />
        <Logo to="/admin" />
        <span className="admin-tag">ADMIN CONSOLE</span>
        <div className="topbar-center"><FeedBadge health={health} asOf={asOf} /></div>
        <div className="topbar-right">
          <ThemeToggle />
          <Bell to="/admin/notifications" />
          <div className="user-chip" title={user?.email}>
            <span className="user-avatar admin">{(user?.email || 'A')[0].toUpperCase()}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={logout}>Logout</button>
          </div>
        </div>
      </header>
      <div className="shell-body">
        {menuOpen && <div className="nav-overlay" onClick={close} />}
        <nav className={`sidebar${menuOpen ? ' open' : ''}`} aria-label="Admin">
          {A_NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className="side-link" onClick={close}>
              <span aria-hidden>{n.icon}</span>{n.label}
            </NavLink>
          ))}
        </nav>
        <main className="content"><Outlet /></main>
      </div>
    </div>
  );
}
