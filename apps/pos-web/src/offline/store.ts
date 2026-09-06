import { MenuItem, RecipeLine } from '../api/types';
import { db } from './db';
import { LocalOrder, LocalOrderLine, LocalPayment } from './types';

// Same pub-sub shape as api/client.ts's onAuthChange -- lets React state
// (NetworkContext's pending count, POSScreen's local-orders list) stay in
// sync with writes that happen from inside the sync engine, not just from
// UI-triggered actions.
const listeners = new Set<() => void>();
export function onOfflineChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function notify() {
  listeners.forEach((l) => l());
}

// ---- Reference-data cache (read-through fallback when offline) ----

export async function cacheItems(locationId: string, items: MenuItem[]): Promise<void> {
  await db.cachedItems.put({ locationId, items, updatedAt: new Date().toISOString() });
}
export async function getCachedItems(locationId: string): Promise<MenuItem[] | null> {
  const row = await db.cachedItems.get(locationId);
  return row?.items ?? null;
}

export async function cacheRecipe(itemId: string, lines: RecipeLine[]): Promise<void> {
  await db.cachedRecipes.put({ itemId, lines });
}
export async function getCachedRecipe(itemId: string): Promise<RecipeLine[] | null> {
  const row = await db.cachedRecipes.get(itemId);
  return row?.lines ?? null;
}

export async function cacheBalances(locationId: string, balances: Map<string, number>): Promise<void> {
  await db.cachedBalances.put({ locationId, balances: Object.fromEntries(balances), updatedAt: new Date().toISOString() });
}
export async function getCachedBalances(locationId: string): Promise<Map<string, number> | null> {
  const row = await db.cachedBalances.get(locationId);
  return row ? new Map(Object.entries(row.balances)) : null;
}

// ---- Local order queue ----

export async function createLocalOrder(input: {
  locationId: string;
  shiftId: string;
  channel: LocalOrder['channel'];
  lines: LocalOrderLine[];
  estimatedGrandTotal: number;
}): Promise<LocalOrder> {
  const order: LocalOrder = {
    localId: `local_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    locationId: input.locationId,
    shiftId: input.shiftId,
    channel: input.channel,
    lines: input.lines,
    estimatedGrandTotal: input.estimatedGrandTotal,
    createdAt: new Date().toISOString(),
    serverId: null,
    status: 'unsynced',
    syncError: null,
    pendingPayment: null,
    paid: false,
    pendingVoid: false,
    voided: false,
  };
  await db.localOrders.add(order);
  notify();
  return order;
}

// Rare edge case: an order was created successfully online (it has a real
// serverId already) but the immediate follow-up call -- pay or void --
// then hit a real network failure. There's no LocalOrder row for it yet
// (it never needed one), so synthesize one purely to carry the queued
// action through the same sync engine as everything else.
export async function queueActionForServerOrder(input: {
  serverId: string;
  locationId: string;
  shiftId: string;
  channel: LocalOrder['channel'];
  lines: LocalOrderLine[];
  grandTotal: number;
  pendingPayment?: LocalPayment;
  pendingVoid?: boolean;
}): Promise<LocalOrder> {
  const order: LocalOrder = {
    localId: `local_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    locationId: input.locationId,
    shiftId: input.shiftId,
    channel: input.channel,
    lines: input.lines,
    estimatedGrandTotal: input.grandTotal,
    createdAt: new Date().toISOString(),
    serverId: input.serverId,
    status: 'synced',
    syncError: null,
    pendingPayment: input.pendingPayment ?? null,
    paid: false,
    pendingVoid: input.pendingVoid ?? false,
    voided: false,
  };
  await db.localOrders.add(order);
  notify();
  return order;
}

export async function listLocalOrders(shiftId: string): Promise<LocalOrder[]> {
  return db.localOrders.where('shiftId').equals(shiftId).toArray();
}

export async function queueLocalPayment(localId: string, payment: LocalPayment): Promise<void> {
  await db.localOrders.update(localId, { pendingPayment: payment });
  notify();
}

export async function queueLocalVoid(localId: string): Promise<void> {
  await db.localOrders.update(localId, { pendingVoid: true });
  notify();
}

export async function updateLocalOrder(localId: string, changes: Partial<LocalOrder>): Promise<void> {
  await db.localOrders.update(localId, changes);
  notify();
}

export async function deleteLocalOrder(localId: string): Promise<void> {
  await db.localOrders.delete(localId);
  notify();
}
