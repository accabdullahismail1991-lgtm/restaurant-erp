import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, isNetworkError } from '../api/client';
import { CartLine, InventoryBalance, Location, MenuItem, Order, OrderChannel, RecipeLine } from '../api/types';
import { VAT_RATE } from '../constants';
import { useShift } from '../context/ShiftContext';
import { useToast } from '../context/ToastContext';
import {
  cacheBalances,
  cacheItems,
  cacheRecipe,
  createLocalOrder,
  getCachedBalances,
  getCachedItems,
  getCachedRecipe,
  onOfflineChange,
  queueActionForServerOrder,
  queueLocalPayment,
  queueLocalVoid,
} from '../offline/store';
import { runSync } from '../offline/syncEngine';
import { DisplayOrder, LocalOrder } from '../offline/types';
import { db } from '../offline/db';
import Header from '../components/Header';
import MenuGrid from '../components/MenuGrid';
import CartPanel from '../components/CartPanel';
import PaymentModal from '../components/PaymentModal';
import OrdersPanel from '../components/OrdersPanel';

// What's opened in the payment modal: either a real server order (grand
// total is authoritative) or a not-yet-synced LocalOrder (grand total is
// still just the client-side estimate -- see CartPanel's own disclaimer).
export type PayTarget = { kind: 'server'; order: Order } | { kind: 'local'; order: LocalOrder };

function localOrderToDisplay(o: LocalOrder): DisplayOrder {
  const status = o.voided ? 'VOIDED' : o.paid ? 'PAID' : 'SENT_TO_KITCHEN';
  return {
    id: `local:${o.localId}`,
    isLocal: true,
    localId: o.localId,
    createdAt: o.createdAt,
    status,
    grandTotal: o.estimatedGrandTotal.toFixed(2),
    lineCount: o.lines.reduce((s, l) => s + l.quantity, 0),
    offlineState: o.status === 'sync_failed' ? 'sync_failed' : 'queued',
    syncError: o.syncError,
  };
}

function serverOrderToDisplay(o: Order): DisplayOrder {
  return {
    id: o.id,
    isLocal: false,
    createdAt: o.createdAt,
    status: o.status,
    grandTotal: o.grandTotal,
    lineCount: (o.lines ?? []).reduce((s, l) => s + l.quantity, 0),
  };
}

export default function POSScreen() {
  const { shift } = useShift();
  const { showToast } = useToast();
  const [location, setLocation] = useState<Location | null>(null);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [recipesByItem, setRecipesByItem] = useState<Map<string, RecipeLine[]>>(new Map());
  const [balances, setBalances] = useState<Map<string, number>>(new Map());
  const [serverOrders, setServerOrders] = useState<Order[]>([]);
  const [localOrders, setLocalOrders] = useState<LocalOrder[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [channel, setChannel] = useState<OrderChannel>('DINE_IN');
  const [checkingOut, setCheckingOut] = useState(false);
  const [payingOrder, setPayingOrder] = useState<PayTarget | null>(null);
  const [loaded, setLoaded] = useState(false);

  const locationId = shift!.locationId;

  const refreshLocalOrders = useCallback(async () => {
    const rows = await db.localOrders.where('shiftId').equals(shift!.id).toArray();
    setLocalOrders(rows);
  }, [shift]);

  useEffect(() => {
    void refreshLocalOrders();
  }, [refreshLocalOrders]);

  const loadBalances = useCallback(async () => {
    try {
      const list = await api<InventoryBalance[]>(`/inventory/balances?locationId=${locationId}`);
      const map = new Map(list.map((b) => [b.ingredientId, Number(b.quantity)]));
      setBalances(map);
      await cacheBalances(locationId, map);
    } catch (err) {
      if (!isNetworkError(err)) throw err;
      const cached = await getCachedBalances(locationId);
      if (cached) setBalances(cached);
    }
  }, [locationId]);

  const loadOrders = useCallback(async () => {
    try {
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
      setServerOrders(detailed);
    } catch (err) {
      if (!isNetworkError(err)) throw err;
      // Offline -- keep whatever server orders we last had; the queued
      // localOrders already reflect anything created/paid/voided since then.
    }
  }, [locationId, shift]);

  // The sync engine (NetworkContext) runs independently of this component
  // and can settle a LocalOrder (create it, pay/void it, then delete the
  // now-redundant local row) at any time, including while this screen just
  // sits idle after reconnecting. Without this, a just-synced order would
  // vanish from the list the moment its local row is deleted, instead of
  // reappearing as the real server record -- refetch both server lists on
  // every local-store change so they stay the source of truth again.
  useEffect(
    () =>
      onOfflineChange(() => {
        void refreshLocalOrders();
        void loadOrders();
        void loadBalances();
      }),
    [refreshLocalOrders, loadOrders, loadBalances],
  );

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
        await cacheItems(locationId, activeItems);

        const recipeEntries: Array<[string, RecipeLine[]]> = await Promise.all(
          activeItems.map(async (item): Promise<[string, RecipeLine[]]> => {
            try {
              const lines = await api<RecipeLine[]>(`/items/${item.id}/recipe`);
              await cacheRecipe(item.id, lines);
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
        if (isNetworkError(err)) {
          // No connection at all for the initial load -- fall back to
          // whatever was cached from the last time we were online.
          const [cachedItems, cachedBalancesMap] = await Promise.all([getCachedItems(locationId), getCachedBalances(locationId)]);
          if (cancelled) return;
          if (cachedItems) {
            setItems(cachedItems);
            const entries: Array<[string, RecipeLine[]]> = await Promise.all(
              cachedItems.map(async (item): Promise<[string, RecipeLine[]]> => [item.id, (await getCachedRecipe(item.id)) ?? []]),
            );
            setRecipesByItem(new Map(entries));
          }
          if (cachedBalancesMap) setBalances(cachedBalancesMap);
          showToast('📴 لا يوجد اتصال -- تم تحميل آخر بيانات محفوظة محليًا', 'err');
        } else {
          showToast(err instanceof ApiError ? err.message : 'تعذّر تحميل بيانات نقطة البيع', 'err');
        }
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
    const linesPayload = cart.map((l) => ({ menuItemId: l.menuItem.id, quantity: l.quantity }));
    const subtotal = cart.reduce((s, l) => s + Number(l.menuItem.price) * l.quantity, 0);
    const estimatedGrandTotal = subtotal * (1 + VAT_RATE);
    try {
      const order = await api<Order>('/orders', {
        method: 'POST',
        body: JSON.stringify({ locationId, shiftId: shift!.id, channel, lines: linesPayload }),
      });
      showToast('✅ تم إنشاء الطلب', 'ok');
      setCart([]);
      setPayingOrder({ kind: 'server', order });
      await Promise.all([loadBalances(), loadOrders()]);
    } catch (err) {
      if (isNetworkError(err)) {
        const local = await createLocalOrder({ locationId, shiftId: shift!.id, channel, lines: linesPayload, estimatedGrandTotal });
        showToast('📴 لا يوجد اتصال -- تم حفظ الطلب محليًا وسيُزامن تلقائيًا', 'ok');
        setCart([]);
        setPayingOrder({ kind: 'local', order: local });
        await refreshLocalOrders();
      } else {
        showToast(err instanceof ApiError ? err.message : 'تعذّر إنشاء الطلب', 'err');
      }
    } finally {
      setCheckingOut(false);
    }
  };

  const payLocalOrder = async (localId: string, payment: { method: 'CASH' | 'CARD'; mode: 'MANUAL' | 'INTEGRATED'; amount: number }) => {
    await queueLocalPayment(localId, payment);
    await refreshLocalOrders();
    void runSync(); // resolves immediately if we're actually online already
  };

  const voidOrder = async (displayOrder: DisplayOrder) => {
    try {
      if (displayOrder.isLocal && displayOrder.localId) {
        await queueLocalVoid(displayOrder.localId);
        await refreshLocalOrders();
        void runSync();
        showToast('✅ سيُلغى الطلب عند مزامنته', 'ok');
        return;
      }
      await api(`/orders/${displayOrder.id}/void`, { method: 'POST' });
      showToast('✅ تم إلغاء الطلب', 'ok');
      await Promise.all([loadBalances(), loadOrders()]);
    } catch (err) {
      if (isNetworkError(err)) {
        // Order already exists server-side, but the void call itself hit a
        // real network failure -- queue it through the same sync path
        // instead of just reporting failure and losing the intent.
        const order = serverOrders.find((o) => o.id === displayOrder.id);
        if (order) {
          await queueActionForServerOrder({
            serverId: order.id,
            locationId: order.locationId,
            shiftId: order.shiftId!,
            channel: order.channel,
            lines: order.lines.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity })),
            grandTotal: Number(order.grandTotal),
            pendingVoid: true,
          });
          await refreshLocalOrders();
          void runSync();
          showToast('📴 لا يوجد اتصال -- سيُلغى الطلب عند عودة الاتصال', 'ok');
          return;
        }
      }
      showToast(err instanceof ApiError ? err.message : 'تعذّر إلغاء الطلب', 'err');
    }
  };

  const payDisplayOrder = (displayOrder: DisplayOrder) => {
    if (displayOrder.isLocal && displayOrder.localId) {
      const local = localOrders.find((o) => o.localId === displayOrder.localId);
      if (local) setPayingOrder({ kind: 'local', order: local });
      return;
    }
    const order = serverOrders.find((o) => o.id === displayOrder.id);
    if (order) setPayingOrder({ kind: 'server', order });
  };

  const categorizedItems = useMemo(() => items, [items]);

  const displayOrders = useMemo<DisplayOrder[]>(() => {
    const local = localOrders.map(localOrderToDisplay);
    // A local row can reference a real serverId already (e.g. the order was
    // created fine but a follow-up pay/void is what's actually queued) --
    // hide the server list's copy of it until the local row is fully
    // settled and removed, so the same sale doesn't show twice.
    const localServerIds = new Set(localOrders.map((o) => o.serverId).filter((id): id is string => !!id));
    const server = serverOrders.filter((o) => !localServerIds.has(o.id)).map(serverOrderToDisplay);
    return [...local, ...server].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [localOrders, serverOrders]);

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
        <OrdersPanel orders={displayOrders} onPay={payDisplayOrder} onVoid={voidOrder} />
      </main>
      {payingOrder && (
        <PaymentModal
          target={payingOrder}
          onClose={() => setPayingOrder(null)}
          onPaid={async (payment, { queued }) => {
            if (payingOrder.kind === 'local') {
              await payLocalOrder(payingOrder.order.localId, payment);
            } else if (queued) {
              // Order was created online fine, but this pay call itself
              // just hit a real network failure -- queue it for later.
              const order = payingOrder.order;
              await queueActionForServerOrder({
                serverId: order.id,
                locationId: order.locationId,
                shiftId: order.shiftId!,
                channel: order.channel,
                lines: order.lines.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity })),
                grandTotal: Number(order.grandTotal),
                pendingPayment: payment,
              });
              await refreshLocalOrders();
              void runSync();
            }
            showToast(queued ? '📴 لا يوجد اتصال -- سيُسجَّل الدفع عند عودة الاتصال' : '✅ تم الدفع', 'ok');
            setPayingOrder(null);
            await loadOrders();
          }}
        />
      )}
    </div>
  );
}
