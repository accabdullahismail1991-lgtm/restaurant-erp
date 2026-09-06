import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api/client';
import { CartLine, InventoryBalance, Location, MenuItem, Order, OrderChannel, RecipeLine } from '../api/types';
import { useShift } from '../context/ShiftContext';
import { useToast } from '../context/ToastContext';
import Header from '../components/Header';
import MenuGrid from '../components/MenuGrid';
import CartPanel from '../components/CartPanel';
import PaymentModal from '../components/PaymentModal';
import OrdersPanel from '../components/OrdersPanel';

export default function POSScreen() {
  const { shift } = useShift();
  const { showToast } = useToast();
  const [location, setLocation] = useState<Location | null>(null);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [recipesByItem, setRecipesByItem] = useState<Map<string, RecipeLine[]>>(new Map());
  const [balances, setBalances] = useState<Map<string, number>>(new Map());
  const [orders, setOrders] = useState<Order[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [channel, setChannel] = useState<OrderChannel>('DINE_IN');
  const [checkingOut, setCheckingOut] = useState(false);
  const [payingOrder, setPayingOrder] = useState<Order | null>(null);
  const [loaded, setLoaded] = useState(false);

  const locationId = shift!.locationId;

  const loadBalances = useCallback(async () => {
    const list = await api<InventoryBalance[]>(`/inventory/balances?locationId=${locationId}`);
    setBalances(new Map(list.map((b) => [b.ingredientId, Number(b.quantity)])));
  }, [locationId]);

  const loadOrders = useCallback(async () => {
    const list = await api<Order[]>(`/orders?locationId=${locationId}`);
    const shiftOrders = list.filter((o) => o.shiftId === shift!.id);
    // The list endpoint omits nested `lines` (matches the API's general
    // list-vs-detail contract); fetch full detail per order so OrdersPanel
    // has the line data it needs.
    const detailed = await Promise.all(
      shiftOrders.map(async (o) => {
        try {
          return await api<Order>(`/orders/${o.id}`);
        } catch {
          return o; // fall back to the summary shape rather than breaking the whole list
        }
      }),
    );
    setOrders(detailed);
  }, [locationId, shift]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [loc, activeItems] = await Promise.all([
          api<Location>(`/locations/${locationId}`),
          api<MenuItem[]>('/items').then((list) => list.filter((i) => i.isActive)),
        ]);
        if (cancelled) return;
        setLocation(loc);
        setItems(activeItems);

        const recipeEntries: Array<[string, RecipeLine[]]> = await Promise.all(
          activeItems.map(async (item): Promise<[string, RecipeLine[]]> => {
            try {
              const lines = await api<RecipeLine[]>(`/items/${item.id}/recipe`);
              return [item.id, lines];
            } catch {
              return [item.id, []]; // don't let one item's recipe fetch break the whole screen
            }
          }),
        );
        if (cancelled) return;
        setRecipesByItem(new Map(recipeEntries));

        await Promise.all([loadBalances(), loadOrders()]);
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : 'تعذّر تحميل بيانات نقطة البيع', 'err');
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId]);

  const qtyInCart = useCallback((itemId: string) => cart.find((l) => l.menuItem.id === itemId)?.quantity ?? 0, [cart]);

  // Mirrors the same recipe-explosion logic the API applies at order
  // creation (docs/ARCHITECTURE.md's Sales <-> Items <-> Inventory point)
  // -- purely a client-side UX hint (out-of-stock badges); the server is
  // still the sole source of truth and will reject the order for real if
  // stock actually runs short between this read and checkout.
  const makeableCount = useCallback(
    (item: MenuItem) => {
      const recipe = recipesByItem.get(item.id) ?? [];
      if (!recipe.length) return Infinity;
      let max = Infinity;
      for (const line of recipe) {
        const available = balances.get(line.ingredient.id) ?? 0;
        const possible = Math.floor(available / Number(line.quantity));
        if (possible < max) max = possible;
      }
      return max;
    },
    [recipesByItem, balances],
  );

  const addToCart = (item: MenuItem) => {
    setCart((prev) => {
      const existing = prev.find((l) => l.menuItem.id === item.id);
      if (existing) return prev.map((l) => (l.menuItem.id === item.id ? { ...l, quantity: l.quantity + 1 } : l));
      return [...prev, { menuItem: item, quantity: 1 }];
    });
  };
  const incLine = (itemId: string) => {
    const item = items.find((i) => i.id === itemId);
    if (item && makeableCount(item) - qtyInCart(itemId) <= 0) {
      showToast('لا يمكن زيادة الكمية -- المخزون غير كافٍ', 'err');
      return;
    }
    setCart((prev) => prev.map((l) => (l.menuItem.id === itemId ? { ...l, quantity: l.quantity + 1 } : l)));
  };
  const decLine = (itemId: string) => {
    setCart((prev) =>
      prev.map((l) => (l.menuItem.id === itemId ? { ...l, quantity: l.quantity - 1 } : l)).filter((l) => l.quantity > 0),
    );
  };
  const clearCart = () => setCart([]);

  const checkout = async () => {
    if (!cart.length) return;
    setCheckingOut(true);
    try {
      const order = await api<Order>('/orders', {
        method: 'POST',
        body: JSON.stringify({
          locationId,
          shiftId: shift!.id,
          channel,
          lines: cart.map((l) => ({ menuItemId: l.menuItem.id, quantity: l.quantity })),
        }),
      });
      showToast('✅ تم إنشاء الطلب', 'ok');
      setCart([]);
      setPayingOrder(order);
      await Promise.all([loadBalances(), loadOrders()]);
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'تعذّر إنشاء الطلب', 'err');
    } finally {
      setCheckingOut(false);
    }
  };

  const voidOrder = async (order: Order) => {
    try {
      await api(`/orders/${order.id}/void`, { method: 'POST' });
      showToast('✅ تم إلغاء الطلب', 'ok');
      await Promise.all([loadBalances(), loadOrders()]);
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'تعذّر إلغاء الطلب', 'err');
    }
  };

  const categorizedItems = useMemo(() => items, [items]);

  if (!loaded) return <div className="loading-screen">جارٍ تحميل نقطة البيع...</div>;

  return (
    <div className="app-shell">
      <Header location={location} />
      <main className="pos-main">
        <div className="pos-grid">
          <MenuGrid items={categorizedItems} makeableCount={makeableCount} qtyInCart={qtyInCart} onAdd={addToCart} />
          <CartPanel
            cart={cart}
            channel={channel}
            setChannel={setChannel}
            onInc={incLine}
            onDec={decLine}
            onCheckout={checkout}
            onClear={clearCart}
            busy={checkingOut}
          />
        </div>
        <OrdersPanel orders={orders} onPay={setPayingOrder} onVoid={voidOrder} />
      </main>
      {payingOrder && (
        <PaymentModal
          order={payingOrder}
          onClose={() => setPayingOrder(null)}
          onPaid={async () => {
            showToast('✅ تم الدفع', 'ok');
            setPayingOrder(null);
            await loadOrders();
          }}
        />
      )}
    </div>
  );
}
