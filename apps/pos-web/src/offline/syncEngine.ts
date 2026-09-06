import { api, ApiError, isNetworkError } from '../api/client';
import { Order } from '../api/types';
import { db } from './db';
import { deleteLocalOrder, updateLocalOrder } from './store';
import { LocalOrder } from './types';

let syncing = false;

// Replays every not-yet-settled LocalOrder against the real API, in the
// order they were created, exactly like a normal online checkout would
// have called them: POST /orders, then (if a payment was queued) POST
// .../pay, then (if a void was queued) POST .../void.
//
// A real network failure (isNetworkError) means we're still offline --
// stop the whole pass immediately and let the next 'online' event or
// periodic retry try again from where we left off. A server-side
// rejection (ApiError -- e.g. stock genuinely ran out by the time this
// synced) is NOT retried and does NOT discard the sale: docs/ARCHITECTURE.md's
// Offline-first section leaves "block the sale vs. allow negative stock"
// as a business decision that needs a human, so we flag the row
// sync_failed and move on to the next order instead of guessing.
export async function runSync(): Promise<void> {
  if (syncing || !navigator.onLine) return;
  syncing = true;
  try {
    const pending = await db.localOrders.where('status').notEqual('sync_failed').sortBy('createdAt');
    for (const order of pending) {
      if (order.status === 'synced' && !order.pendingPayment && !order.pendingVoid) {
        await deleteLocalOrder(order.localId); // fully settled, server is authoritative now
        continue;
      }
      try {
        await syncOne(order);
      } catch (err) {
        if (isNetworkError(err)) return; // offline again -- stop, retry later
        throw err; // unexpected -- surface it rather than looping silently
      }
    }
  } finally {
    syncing = false;
  }
}

async function syncOne(order: LocalOrder): Promise<void> {
  try {
    let serverId = order.serverId;
    if (!serverId) {
      const created = await api<Order>('/orders', {
        method: 'POST',
        body: JSON.stringify({
          locationId: order.locationId,
          shiftId: order.shiftId,
          channel: order.channel,
          lines: order.lines,
        }),
      });
      serverId = created.id;
      await updateLocalOrder(order.localId, { serverId, status: 'synced' });
    }

    if (order.pendingPayment && !order.paid) {
      await api(`/orders/${serverId}/pay`, {
        method: 'POST',
        body: JSON.stringify({ payments: [order.pendingPayment] }),
      });
      await updateLocalOrder(order.localId, { paid: true, pendingPayment: null });
    }

    if (order.pendingVoid && !order.voided) {
      await api(`/orders/${serverId}/void`, { method: 'POST' });
      await updateLocalOrder(order.localId, { voided: true, pendingVoid: false });
    }

    const settled = await db.localOrders.get(order.localId);
    if (settled && settled.status === 'synced' && !settled.pendingPayment && !settled.pendingVoid) {
      await deleteLocalOrder(order.localId);
    }
  } catch (err) {
    if (isNetworkError(err)) throw err;
    const message = err instanceof ApiError ? err.message : 'فشل غير متوقع أثناء المزامنة';
    await updateLocalOrder(order.localId, { status: 'sync_failed', syncError: message });
  }
}
