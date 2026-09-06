import { useState } from 'react';
import { api, ApiError, isNetworkError } from '../api/client';
import type { PayTarget } from '../screens/POSScreen';

type Method = 'CASH' | 'CARD';
type Payment = { method: Method; mode: 'MANUAL' | 'INTEGRATED'; amount: number };

export default function PaymentModal({
  target,
  onClose,
  onPaid,
}: {
  target: PayTarget;
  onClose: () => void;
  // `queued` is true whenever this payment could not be submitted to the
  // server right now and must go through the offline sync queue instead --
  // always true for a still-local order, and true for a server order only
  // if the pay call itself hit a real network failure.
  onPaid: (payment: Payment, info: { queued: boolean }) => void | Promise<void>;
}) {
  const [method, setMethod] = useState<Method>('CASH');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const grandTotal = target.kind === 'server' ? Number(target.order.grandTotal) : target.order.estimatedGrandTotal;

  const pay = async () => {
    setBusy(true);
    setError(null);
    const payment: Payment = { method, mode: method === 'CASH' ? 'MANUAL' : 'INTEGRATED', amount: grandTotal };
    try {
      if (target.kind === 'server') {
        // Real server order -- pay it for real, right now.
        await api(`/orders/${target.order.id}/pay`, {
          method: 'POST',
          body: JSON.stringify({ payments: [payment] }),
        });
        await onPaid(payment, { queued: false });
        return;
      }
      // Local (not-yet-synced) orders don't have a server id to pay
      // against yet -- onPaid queues the payment locally and the sync
      // engine submits it for real once the order itself has synced.
      await onPaid(payment, { queued: true });
    } catch (err) {
      if (target.kind === 'server' && isNetworkError(err)) {
        // Went offline between opening the modal and confirming payment --
        // still record the payment intent locally rather than losing it.
        await onPaid(payment, { queued: true });
        return;
      }
      setError(err instanceof ApiError ? err.message : 'تعذّر تسجيل الدفع');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h2>💳 الدفع</h2>
        {target.kind === 'local' && <div className="estimate-note">* إجمالي تقديري -- الطلب لم يُزامَن بعد مع السيرفر</div>}
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
