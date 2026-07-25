// IPOs — apply to open issues and track upcoming & recent listings (Groww-style).
// Live: fetch on mount, re-fetch on 'prices' ticks (throttled to once per ~4s).
import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { api, inr, num } from '../../api';
import { subscribe } from '../../realtime';
import { useToast, Card, Spinner, EmptyState, Segmented, Modal, Field } from '../../components/ui';

// Tiny local ISO ('YYYY-MM-DD') -> '30 Jul' formatter. Falls back gracefully.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDay(s) {
  if (!s) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  if (!m) return String(s);
  const day = parseInt(m[3], 10);
  const mon = MONTHS[parseInt(m[2], 10) - 1] || '';
  return `${day} ${mon}`;
}

const STATUS_OPTIONS = [
  { value: 'Open', label: 'Open' },
  { value: 'Upcoming', label: 'Upcoming' },
  { value: 'Listed', label: 'Listed' },
];

function StatBox({ label, value }) {
  return (
    <div>
      <div className="small text-muted">{label}</div>
      <div className="mono" style={{ fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>
        {value}
      </div>
    </div>
  );
}

function ApplyModal({ ipo, onClose, onSubmit }) {
  const [lots, setLots] = useState(1);
  const n = Math.max(1, Math.floor(Number(lots) || 1));
  const hi = Array.isArray(ipo.price_band) ? Number(ipo.price_band[1]) || 0 : 0;
  const shares = n * (Number(ipo.lot) || 0);
  const amount = shares * hi;
  return (
    <Modal open onClose={onClose} title={ipo.name}>
      <p className="small text-muted" style={{ marginTop: 0 }}>
        {ipo.symbol} · Lot {num(ipo.lot)} shares · Band {inr(Array.isArray(ipo.price_band) ? ipo.price_band[0] : 0)} – {inr(hi)}
      </p>
      <Field label="Lots" hint={`${num(shares)} shares at the upper band price`}>
        <input
          type="number"
          min={1}
          step={1}
          value={lots}
          onChange={(e) => setLots(e.target.value)}
          className="mono"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        />
      </Field>
      <div
        className="row-between mt-2"
        style={{
          padding: '14px 16px',
          background: 'var(--bg-soft)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
        }}
      >
        <span className="text-muted">Amount</span>
        <span className="mono" style={{ fontSize: 16, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
          {inr(amount)}
        </span>
      </div>
      <p className="small text-muted mt-2">
        Cut-off / upper band applied at bidding. Final allotment is subject to subscription.
      </p>
      <div className="row mt-3" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={() => onSubmit(n)}>Apply</button>
      </div>
    </Modal>
  );
}

function IpoCard({ ipo, onApply }) {
  const band = Array.isArray(ipo.price_band) ? ipo.price_band : [0, 0];
  const isMainboard = ipo.category === 'Mainboard';
  const gain = ipo.gain_pct;
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: 18,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Top row: name + symbol / category badge */}
      <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.25 }}>{ipo.name}</div>
          <div className="mono small text-muted" style={{ marginTop: 2 }}>{ipo.symbol}</div>
        </div>
        <span className={`badge ${isMainboard ? 'badge-blue' : 'badge-gray'}`}>{ipo.category}</span>
      </div>

      {/* Stats block (2-col) */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 14,
          marginTop: 16,
          paddingTop: 16,
          borderTop: '1px solid var(--border)',
        }}
      >
        <StatBox label="Price Band" value={`${inr(band[0])} – ${inr(band[1])}`} />
        <StatBox label="Lot Size" value={`${num(ipo.lot)} shares`} />
        <StatBox label="Min Investment" value={inr(ipo.min_investment)} />
        <StatBox label="Issue Size" value={ipo.issue_size} />
      </div>

      {/* Dates line */}
      <div className="small text-muted" style={{ marginTop: 14 }}>
        Open {fmtDay(ipo.open)} – {fmtDay(ipo.close)}  ·  Lists {fmtDay(ipo.listing)}
      </div>

      {/* GMP pill */}
      {Number(ipo.gmp) > 0 && (
        <div style={{ marginTop: 12 }}>
          <span className="badge badge-amber mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
            GMP {inr(ipo.gmp)}
          </span>
        </div>
      )}

      {/* Status-specific footer */}
      <div
        className="row-between mt-3"
        style={{ marginTop: 'auto', paddingTop: 14, alignItems: 'center', gap: 12, minHeight: 0 }}
      >
        {ipo.status === 'Open' && (
          <>
            <div className="small">
              <span className="text-muted">Subscribed </span>
              <span className="mono" style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                {ipo.subscribed}x
              </span>
            </div>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => onApply(ipo)}>Apply</button>
          </>
        )}

        {ipo.status === 'Upcoming' && (
          <div className="small text-muted">Opens {fmtDay(ipo.open)}</div>
        )}

        {ipo.status === 'Listed' && (
          <>
            <div className="small">
              <span className="text-muted">Listed at </span>
              <span className="mono" style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                {inr(ipo.listed_at)}
              </span>
            </div>
            <div className="small">
              <span className="text-muted">Listing gain </span>
              <span className={Number(gain) >= 0 ? 'text-up' : 'text-down'} style={{ fontWeight: 700 }}>
                {gain == null ? '—' : `${Number(gain) >= 0 ? '+' : ''}${Number(gain).toFixed(2)}%`}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function Ipo() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('Open');
  const [applying, setApplying] = useState(null);
  const lastFetch = useRef(0);

  const load = useCallback(async () => {
    try {
      const d = await api.get('/api/markets/ipos');
      setData(d);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
    lastFetch.current = Date.now();
    // Keep it live: re-fetch on ticks, throttled to at most once per ~4s.
    const un = subscribe('prices', () => {
      const now = Date.now();
      if (now - lastFetch.current >= 4000) {
        lastFetch.current = now;
        load();
      }
    });
    return un;
  }, [load]);

  const ipos = data?.ipos || [];
  const filtered = useMemo(() => ipos.filter((i) => i.status === tab), [ipos, tab]);

  const submitApplication = useCallback(() => {
    toast.success('Application submitted — you will be notified on allotment. (Demo)');
    setApplying(null);
  }, [toast]);

  if (loading) return <Spinner label="Loading IPOs…" />;

  return (
    <>
      <div>
        <h1 className="page-title">IPOs</h1>
        <p className="page-sub">Apply to open issues and track upcoming &amp; recent listings.</p>
      </div>

      <div className="mt-2">
        <Segmented options={STATUS_OPTIONS} value={tab} onChange={setTab} />
      </div>

      {filtered.length === 0 ? (
        <Card className="mt-3">
          <EmptyState
            icon="🗓️"
            title={`No ${tab.toLowerCase()} IPOs`}
            text={
              tab === 'Open'
                ? 'There are no issues open for bidding right now. Check the Upcoming tab.'
                : tab === 'Upcoming'
                ? 'No upcoming issues announced yet. Check back soon.'
                : 'No recent listings to show yet.'
            }
          />
        </Card>
      ) : (
        <div
          className="mt-3"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
            gap: 16,
          }}
        >
          {filtered.map((ipo) => (
            <IpoCard key={ipo.symbol} ipo={ipo} onApply={setApplying} />
          ))}
        </div>
      )}

      {data?.note && <p className="small text-muted mt-3">{data.note}</p>}

      {applying && (
        <ApplyModal ipo={applying} onClose={() => setApplying(null)} onSubmit={submitApplication} />
      )}
    </>
  );
}
