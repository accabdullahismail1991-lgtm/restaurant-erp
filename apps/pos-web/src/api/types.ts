// Mirrors the API's JSON shapes. Prisma Decimal fields serialize as
// strings over the wire (confirmed against the running API), so every
// money/quantity field here is typed `string` and converted with
// Number(...) at the point of use -- never assumed to already be numeric.

export interface Location {
  id: string;
  name: string;
  type: 'BRANCH' | 'CENTRAL_KITCHEN' | 'WAREHOUSE';
  address: string | null;
  isActive: boolean;
}

export interface MenuItem {
  id: string;
  name: string;
  category: string;
  price: string;
  isActive: boolean;
}

export interface RecipeLine {
  id: string;
  quantity: string;
  ingredient: { id: string; name: string; unit: string; kind: string };
}

export interface InventoryBalance {
  ingredientId: string;
  locationId: string;
  quantity: string;
  location?: { id: string; name: string };
}

export type ShiftStatus = 'OPEN' | 'CLOSED';

export interface Shift {
  id: string;
  locationId: string;
  openingFloat: string;
  closingCounted: string | null;
  expectedCash: string | null;
  variance: string | null;
  openedAt: string;
  closedAt: string | null;
}

export type OrderChannel = 'DINE_IN' | 'TAKEAWAY' | 'DRIVE_THRU' | 'DELIVERY_PARTNER' | 'BRAND_APP';
export type OrderStatus = 'OPEN' | 'SENT_TO_KITCHEN' | 'READY' | 'PAID' | 'VOIDED';

export interface OrderLine {
  id: string;
  menuItemId: string;
  quantity: number;
  unitPrice: string;
}

export interface Order {
  id: string;
  locationId: string;
  shiftId: string | null;
  channel: OrderChannel;
  status: OrderStatus;
  subtotal: string;
  discountTotal: string;
  vatTotal: string;
  grandTotal: string;
  createdAt: string;
  paidAt: string | null;
  lines: OrderLine[];
}

export interface CartLine {
  menuItem: MenuItem;
  quantity: number;
}
