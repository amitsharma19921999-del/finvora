// App shells: InvestorLayout (top bar + bottom tab bar on mobile, side rail on
// desktop) and AdminLayout (Administrator Console sidebar per BPD Section 6.1).
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

const I_NAV = [
  { to: '/app', label: 'Home', icon: '🏠', end: true },
  { to: '/app/markets', label: 'Markets', icon: '📊' },
  { to: '/app/trade', label: 'Stocks', icon: '📈' },
  { to: '/app/fno', label: 'F&O', icon: '🎯' },
  { to: '/app/ipo', label: 'IPO', icon: '🚀' },
  { to: '/app/portfolio', label: 'Portfolio', icon: '💼' },
  { to: '/app/orders', label: 'Orders', icon: '🧾' },
  { to: '/app/funds', label: 'Funds', icon: '💰' },
];
// Mobile bottom bar shows a focused subset.
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
  return (
    <div className="shell">
      <header className="topbar">
        <Logo to="/app" />
        <div className="topbar-center"><FeedBadge health={health} asOf={asOf} /></div>
        <div className="topbar-right">
          <InstallButton />
          <Bell to="/app/notifications" />
          <div className="user-chip" title={user?.email}>
            <span className="user-avatar">{(user?.email || 'U')[0].toUpperCase()}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={logout}>Logout</button>
          </div>
        </div>
      </header>
      <div className="shell-body">
        <nav className="siderail" aria-label="Main">
          {I_NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className="rail-link">
              <span aria-hidden>{n.icon}</span>{n.label}
            </NavLink>
          ))}
          <NavLink to="/app/withdraw" className="rail-link"><span aria-hidden>🏦</span>Withdraw</NavLink>
          <NavLink to="/app/transactions" className="rail-link"><span aria-hidden>📒</span>History</NavLink>
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
  { to: '/admin/feed', label: 'Feed Monitor', icon: '📡' },
  { to: '/admin/settings', label: 'Settings', icon: '⚙️' },
];

export function AdminLayout() {
  const { user, logout } = useAuth();
  const { health, asOf } = useLivePrices();
  return (
    <div className="shell shell-admin">
      <header className="topbar">
        <Logo to="/admin" />
        <span className="admin-tag">ADMIN CONSOLE</span>
        <div className="topbar-center"><FeedBadge health={health} asOf={asOf} /></div>
        <div className="topbar-right">
          <Bell to="/admin/notifications" />
          <div className="user-chip" title={user?.email}>
            <span className="user-avatar admin">{(user?.email || 'A')[0].toUpperCase()}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={logout}>Logout</button>
          </div>
        </div>
      </header>
      <div className="shell-body">
        <nav className="sidebar" aria-label="Admin">
          {A_NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className="side-link">
              <span aria-hidden>{n.icon}</span>{n.label}
            </NavLink>
          ))}
        </nav>
        <main className="content"><Outlet /></main>
      </div>
    </div>
  );
}
