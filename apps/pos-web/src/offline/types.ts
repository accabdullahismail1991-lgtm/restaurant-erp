import { OrderChannel, OrderStatus } from '../api/types';

export interface LocalOrderLine {
  menuItemId: string;
  quantity: number;
}

export interface LocalPayment {
  method: 'CASH' | 'CARD';
  mode: 'MANUAL' | 'INTEGRATED';
  amount: number;
}

// A sale captured while offline (or while an online attempt hit a real
// network failure). Always created locally first with a client-generated
// id -- the server's own id (serverId) is filled in once /orders actually
// succeeds. Deleted once fully settled (created + paid-if-queued +
// voided-if-queued) so the server's own order list becomes the source of
// truth again; kept around indefinitely when sync_failed, since that means
// the server was reached but genuinely rejected the sale (e.g. stock ran
// out for real) and needs a human decision, not a silent retry.
export interface LocalOrder {
  localId: string;
  locationId: string;
  shiftId: string;
  channel: OrderChannel;
  lines: LocalOrderLine[];
  estimatedGrandTotal: number;
  createdAt: string;
  serverId: string | null;
  status: 'unsynced' | 'synced' | 'sync_failed';
  syncError: string | null;
  pendingPayment: LocalPayment | null;
  paid: boolean;
  pendingVoid: boolean;
  voided: boolean;
}

// Unified shape OrdersPanel renders, whether the row comes from the
// server's own order list or from a not-yet-settled LocalOrder.
export interface DisplayOrder {
  id: string;
  isLocal: boolean;
  localId?: string;
  createdAt: string;
  status: OrderStatus;
  grandTotal: string;
  lineCount: number;
  offlineState?: 'queued' | 'sync_failed';
  syncError?: string | null;
}
