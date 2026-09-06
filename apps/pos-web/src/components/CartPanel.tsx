import { CartLine, OrderChannel } from '../api/types';
import { VAT_RATE } from '../constants';

const CHANNEL_LABEL: Record<OrderChannel, string> = {
  DINE_IN: 'صالة',
  TAKEAWAY: 'تيك أواي',
  DRIVE_THRU: 'Drive-thru',
  DELIVERY_PARTNER: 'توصيل خارجي',
  BRAND_APP: 'تطبيق العلامة',
};

interface Props {
  cart: CartLine[];
  channel: OrderChannel;
  setChannel: (c: OrderChannel) => void;
  onInc: (itemId: string) => void;
  onDec: (itemId: string) => void;
  onCheckout: () => void;
  onClear: () => void;
  busy: boolean;
}

export default function CartPanel({ cart, channel, setChannel, onInc, onDec, onCheckout, onClear, busy }: Props) {
  const subtotal = cart.reduce((s, l) => s + Number(l.menuItem.price) * l.quantity, 0);
  const vat = subtotal * VAT_RATE;
  const total = subtotal + vat;
  const count = cart.reduce((s, l) => s + l.quantity, 0);

  return (
    <div className="ticket">
      <h3>
        الطلب الحالي <span className="count">{count} صنف</span>
      </h3>
      <div>
        {cart.length === 0 ? (
          <div className="order-empty">لم تتم إضافة أصناف بعد</div>
        ) : (
          cart.map((l) => (
            <div className="order-line" key={l.menuItem.id}>
              <span className="oname">{l.menuItem.name}</span>
              <span className="oqty">
                <button className="step" onClick={() => onDec(l.menuItem.id)}>
                  −
                </button>
                <span>{l.quantity}</span>
                <button className="step" onClick={() => onInc(l.menuItem.id)}>
                  +
                </button>
              </span>
              <span className="oprice">{(Number(l.menuItem.price) * l.quantity).toFixed(2)}</span>
            </div>
          ))
        )}
      </div>

      <select className="channel-select" value={channel} onChange={(e) => setChannel(e.target.value as OrderChannel)}>
        {Object.entries(CHANNEL_LABEL).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>

      <div className="ticket-totals">
        <div className="row">
          <span>المجموع الفرعي</span>
          <span>{subtotal.toFixed(2)} ر.س</span>
        </div>
        <div className="row">
          <span>ضريبة القيمة المضافة (15%)</span>
          <span>{vat.toFixed(2)} ر.س</span>
        </div>
        <div className="row total">
          <span>الإجمالي</span>
          <span>{total.toFixed(2)} ر.س</span>
        </div>
        <div className="estimate-note">* تقديري -- الإجمالي الفعلي يُحسب عند إنشاء الطلب</div>
      </div>

      <button className="btn full" disabled={!cart.length || busy} onClick={onCheckout}>
        {busy ? 'جارٍ الإرسال...' : 'إتمام البيع'}
      </button>
      <button className="btn ghost full" style={{ marginTop: 6 }} disabled={!cart.length || busy} onClick={onClear}>
        إفراغ الطلب
      </button>
    </div>
  );
}
