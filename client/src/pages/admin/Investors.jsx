// Admin — Investor Management list (BPD Section 4).
// Search across name / mobile / email, inspect status at a glance, click through
// to the full investor profile.
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, inr, num, fmtDateTime } from '../../api';
import { useToast, Card, Spinner, DataTable, StatusBadge } from '../../components/ui';

export default function Investors() {
  const toast = useToast();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState(null); // null = loading
  const firstLoad = useRef(true);

  useEffect(() => {
    let alive = true;
    const fetchRows = async () => {
      try {
        const d = await api.get(`/api/admin/investors?q=${encodeURIComponent(q.trim())}`);
        if (alive) setRows(d.investors);
      } catch (e) {
        if (alive) { setRows([]); toast.error(e.message); }
      }
    };
    // First paint loads immediately; typing is debounced 300ms.
    const delay = firstLoad.current ? 0 : 300;
    firstLoad.current = false;
    const t = setTimeout(fetchRows, delay);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const columns = [
    { key: 'id', label: 'ID', width: 56, render: (r) => <span className="mono">#{r.id}</span> },
    {
      key: 'full_name', label: 'Investor',
      render: (r) => (
        <div>
          <div>{r.full_name || <span className="text-muted">Name pending KYC</span>}</div>
          <div className="small text-muted mono">{r.mobile} · {r.email}</div>
        </div>
      ),
    },
    { key: 'status', label: 'Account', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'kyc_status', label: 'KYC', render: (r) => <StatusBadge status={r.kyc_status || 'Not Submitted'} small /> },
    { key: 'bank_status', label: 'Bank', render: (r) => <StatusBadge status={r.bank_status || 'Not Submitted'} small /> },
    { key: 'balance', label: 'Wallet Balance', align: 'right', render: (r) => <span className="mono">{inr(r.balance)}</span> },
    { key: 'order_count', label: 'Orders', align: 'right', render: (r) => num(r.order_count) },
    { key: 'created_at', label: 'Registered', render: (r) => <span className="small">{fmtDateTime(r.created_at)}</span> },
  ];

  return (
    <div>
      <h1 className="page-title">Investors</h1>
      <p className="page-sub">Every registered investor — search by name, mobile or email, then open a profile to review documents, wallet and activity.</p>

      <Card
        title="Investor directory"
        subtitle={rows ? `${rows.length} investor${rows.length === 1 ? '' : 's'} shown` : 'Loading…'}
        actions={
          <input
            className="input"
            style={{ minWidth: 220 }}
            type="search"
            placeholder="Search name, mobile or email…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search investors"
          />
        }
        pad={false}
      >
        {rows === null ? (
          <div className="card-body"><Spinner label="Loading investors…" /></div>
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            empty={q.trim() ? 'No investors match your search.' : 'No investors have registered yet.'}
            onRowClick={(r) => navigate(`/admin/investors/${r.id}`)}
          />
        )}
      </Card>
    </div>
  );
}
