import Dexie, { Table } from 'dexie';
import { MenuItem, RecipeLine } from '../api/types';
import { LocalOrder } from './types';

interface CachedItems {
  locationId: string; // active menu items don't vary by location today, but keyed anyway for future-proofing
  items: MenuItem[];
  updatedAt: string;
}

interface CachedRecipe {
  itemId: string;
  lines: RecipeLine[];
}

interface CachedBalances {
  locationId: string;
  balances: Record<string, number>; // ingredientId -> quantity
  updatedAt: string;
}

// Local persistence for pos-web's offline-first mode (docs/ARCHITECTURE.md
// Phase 8): reference data cached here so the POS screen can still render
// (menu, prices, stock hints) with no connection, and LocalOrder rows form
// the sync queue for sales made while offline.
class PosWebDB extends Dexie {
  localOrders!: Table<LocalOrder, string>;
  cachedItems!: Table<CachedItems, string>;
  cachedRecipes!: Table<CachedRecipe, string>;
  cachedBalances!: Table<CachedBalances, string>;

  constructor() {
    super('pos_web_offline_v1');
    this.version(1).stores({
      localOrders: 'localId, shiftId, status, createdAt',
      cachedItems: 'locationId',
      cachedRecipes: 'itemId',
      cachedBalances: 'locationId',
    });
  }
}

export const db = new PosWebDB();
