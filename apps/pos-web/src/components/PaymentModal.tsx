import { useState } from 'react';
import { api, ApiError } from '../api/client';
import { Order } from '../api/types';

type Method = 'CASH' | 'CARD';

export default function PaymentModal({ order, onClose, onPaid }: { order: Order; onClose: () => void; onPaid: () => void }) {
  const [method, setMethod] = useState<Method>('CASH');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const grandTotal = Number(order.grandTotal);

  const pay = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/orders/${order.id}/pay`, {
        method: 'POST',
        body: JSON.stringify({
          payments: [{ method, mode: method === 'CASH' ? 'MANUAL' : 'INTEGRATED', amount: grandTotal }],
        }),
      });
      onPaid();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذّر تسجيل الدفع');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h2>💳 الدفع</h2>
        <div className="grand">{grandTotal.toFixed(2)} ر.س</div>
        <div className="pay-methods">
          <button className={method === 'CASH' ? 'active' : ''} onClick={() => setMethod('CASH')}>
            نقدي
          </button>
          <button className={method === 'CARD' ? 'active' : ''} onClick={() => setMethod('CARD')}>
            شبكة
          </button>
        </div>
        {error && <div className="error-msg">❌ {error}</div>}
        <div className="modal-actions">
          <button className="btn" onClick={pay} disabled={busy}>
            {busy ? 'جارٍ التأكيد...' : 'تأكيد الدفع'}
          </button>
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            دفع لاحقًا
          </button>
        </div>
      </div>
    </div>
  );
}
