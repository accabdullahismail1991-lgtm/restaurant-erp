import { FormEvent, useState } from 'react';
import { ApiError } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useShift } from '../context/ShiftContext';
import { useToast } from '../context/ToastContext';
import { Location } from '../api/types';

export default function Header({ location }: { location: Location | null }) {
  const { phone, logout } = useAuth();
  const { shift, closeShift } = useShift();
  const { showToast } = useToast();
  const [closing, setClosing] = useState(false);
  const [closingCounted, setClosingCounted] = useState('');
  const [busy, setBusy] = useState(false);

  const submitClose = async (e: FormEvent) => {
    e.preventDefault();
    const amount = parseFloat(closingCounted);
    if (Number.isNaN(amount) || amount < 0) {
      showToast('اكتب مبلغًا صحيحًا', 'err');
      return;
    }
    setBusy(true);
    try {
      const closed = await closeShift(amount);
      const variance = closed.variance != null ? Number(closed.variance) : 0;
      showToast(variance === 0 ? '✅ تم إغلاق الوردية بالضبط' : `تم إغلاق الوردية -- الفرق: ${variance.toFixed(2)} ر.س`, variance === 0 ? 'ok' : 'err');
      setClosing(false);
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'تعذّر إغلاق الوردية', 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className="top">
      <div>
        <h1>🍽️ كاشير المطعم</h1>
        <div className="shift-info">
          {location?.name} · وردية مفتوحة منذ {shift ? new Date(shift.openedAt).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' }) : ''}
        </div>
      </div>
      <div className="right-group">
        <span className="who">{phone}</span>
        {closing ? (
          <form onSubmit={submitClose} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              className="field"
              style={{ width: 110 }}
              type="number"
              step="0.01"
              placeholder="المبلغ المعدود"
              value={closingCounted}
              onChange={(e) => setClosingCounted(e.target.value)}
              autoFocus
            />
            <button className="btn" type="submit" disabled={busy}>
              تأكيد
            </button>
            <button type="button" className="btn ghost" onClick={() => setClosing(false)}>
              إلغاء
            </button>
          </form>
        ) : (
          <button className="btn ghost" onClick={() => setClosing(true)}>
            إغلاق الوردية
          </button>
        )}
        <button className="btn ghost" onClick={logout}>
          خروج
        </button>
      </div>
    </header>
  );
}
