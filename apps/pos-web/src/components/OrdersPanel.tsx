import { DisplayOrder } from '../offline/types';
import { OrderStatus } from '../api/types';

const STATUS_LABEL: Record<OrderStatus, { text: string; cls: string }> = {
  OPEN: { text: 'مفتوح', cls: '' },
  SENT_TO_KITCHEN: { text: 'قيد التحضير', cls: 'pending' },
  READY: { text: 'جاهز', cls: 'pending' },
  PAID: { text: 'مدفوع', cls: 'paid' },
  VOIDED: { text: 'ملغى', cls: 'voided' },
};

interface Props {
  orders: DisplayOrder[];
  onPay: (order: DisplayOrder) => void;
  onVoid: (order: DisplayOrder) => void;
}

export default function OrdersPanel({ orders, onPay, onVoid }: Props) {
  return (
    <div className="panel">
      <h2>طلبات هذه الوردية</h2>
      {orders.length === 0 ? (
        <div className="empty-state">لا توجد طلبات في هذه الوردية بعد</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>الوقت</th>
                <th>عدد الأصناف</th>
                <th>الإجمالي</th>
                <th>الحالة</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {/* API already returns orders newest-first (createdAt desc); local queued
                  orders are sorted in alongside them the same way (POSScreen). */}
              {orders.map((o) => {
                const status = STATUS_LABEL[o.status];
                const canAct = o.status === 'SENT_TO_KITCHEN' && o.offlineState !== 'sync_failed';
                return (
                  <tr key={o.id}>
                    <td>{new Date(o.createdAt).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' })}</td>
                    <td>{o.lineCount}</td>
                    <td>{Number(o.grandTotal).toFixed(2)}</td>
                    <td>
                      <span className={`badge ${status.cls}`}>{status.text}</span>
                      {o.offlineState === 'queued' && <span className="badge offline-tag"> غير متزامن</span>}
                      {o.offlineState === 'sync_failed' && (
                        <span className="badge offline-tag failed" title={o.syncError ?? ''}>
                          {' '}
                          بحاجة مراجعة
                        </span>
                      )}
                    </td>
                    <td>
                      {canAct && (
                        <>
                          <button className="btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => onPay(o)}>
                            💵 دفع
                          </button>{' '}
                          <button className="btn danger" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => onVoid(o)}>
                            إلغاء
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
