// One-off (but safely re-runnable) import for "مطعم شندوتش"'s real menu:
// parsed from the restaurant's own monthly cost-tracking spreadsheet
// (تقرير تكاليف الأصناف + مصفوفة الوصفات + الأصناف شبه المصنعة + أسعار القنوات
// sheets) into apps/api/prisma/seed-data/shandouch-*.json, then replayed here through
// the SAME REST API every other client uses -- not raw Prisma writes --
// so it goes through the exact same validation (unique-recipe checks,
// permission checks, positive-quantity checks, the SEMI_FINISHED-only
// own-recipe rule) any other caller would hit.
//
// Ingredient unit costs were derived from ~460 individual recipe-cost
// lines in the source spreadsheet; where the SAME ingredient's cost per
// gram/piece disagreed across lines (rounding, or a handful of clear
// data-entry typos -- e.g. one line pricing 20g of onion at 10x every
// other line's rate), the canonical unit cost used here is the mean of
// whichever cluster of lines agrees with itself, discarding values more
// than 2x away from the group's median. The crepe dough ("كريب",
// SEMI_FINISHED) is the one exception: its cost comes from the
// spreadsheet's OWN dedicated BOM sheet (18.3915 SAR / 45 portions =
// 0.4087 SAR/portion), not the general cost sheet's rounded figure.
//
// Run against ANY deployment by pointing API_BASE_URL/ADMIN_PHONE/
// ADMIN_PASSWORD at it:
//   API_BASE_URL=https://restaurant-erp-api.onrender.com \
//   ADMIN_PHONE=+9665... ADMIN_PASSWORD=... \
//   npx ts-node scripts/import-shandouch-menu.ts --confirm
//
// --confirm is required and is not a stand-in for a real confirmation
// prompt -- this WIPES every ingredient/recipe/menu item/branch/customer/
// supplier currently in that database first (via POST /admin/full-wipe),
// keeping only Users/Roles/Permissions, exactly like the admin panel's
// "🗑️ حذف البيانات -> تفريغ كل شيء" button. Never run this against a
// database with real, wanted orders/inventory history still in it.
import * as fs from 'fs';
import * as path from 'path';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const ADMIN_PHONE = process.env.ADMIN_PHONE || '+966500000000';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
const BRANCH_NAME = process.env.BRANCH_NAME || 'مطعم شندوتش - الفرع الرئيسي';

const SEED_DIR = path.join(__dirname, '..', 'prisma', 'seed-data');
type FinalIngredient = { name: string; base_name: string; raw_unit: string; unit_code: string; unit_cost: number; kind: 'RAW_MATERIAL' | 'SEMI_FINISHED' };
type CrepeComponent = { name: string; unit_code: string; unit_cost: number; qty_per_bite: number };
type MenuItemLine = { ingredient: string; quantity: number };
type MenuItem = { name: string; category: string; price: number; lines: MenuItemLine[] };
type ChannelPriceRow = { item: string; channels: Record<string, number> };

const finalIngredients: FinalIngredient[] = JSON.parse(fs.readFileSync(path.join(SEED_DIR, 'shandouch-ingredients.json'), 'utf-8'));
const crepeComponents: CrepeComponent[] = JSON.parse(fs.readFileSync(path.join(SEED_DIR, 'shandouch-crepe-dough-components.json'), 'utf-8'));
const menuItems: MenuItem[] = JSON.parse(fs.readFileSync(path.join(SEED_DIR, 'shandouch-menu-items.json'), 'utf-8'));
// From the source spreadsheet's own "أسعار القنوات" sheet -- each item's
// price as listed by the restaurant per delivery app, separate from its
// dine-in price (MenuItem.price, "الصالة" in that sheet). Only items the
// sheet actually lists a channel price for are included here; 3 items are
// dine-in only and never appear in this file.
const channelPrices: ChannelPriceRow[] = JSON.parse(fs.readFileSync(path.join(SEED_DIR, 'shandouch-channel-prices.json'), 'utf-8'));

const DEFAULT_UNITS = [
  { code: 'g', name: 'جرام' },
  { code: 'kg', name: 'كيلوجرام' },
  { code: 'ml', name: 'مليلتر' },
  { code: 'l', name: 'لتر' },
  { code: 'pcs', name: 'قطعة' },
  { code: 'sachet', name: 'ظرف' },
  { code: 'can', name: 'علبة' },
  { code: 'portion', name: 'لقمة' },
];

// Nominal opening-stock quantity per unit type, ONLY to give the import an
// inventory batch to price recipes off of immediately -- not a real
// physical count. Re-count and adjust via a real stocktake once the
// branch actually has stock on the shelf.
const DEFAULT_QTY: Record<string, number> = { g: 5000, kg: 20, ml: 5000, l: 20, pcs: 200, sachet: 200, can: 100, portion: 200 };

let token = '';

async function api<T>(method: 'GET' | 'POST' | 'PUT', urlPath: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    throw new Error(`${method} ${urlPath} -> ${res.status}: ${text}`);
  }
  return data as T;
}

async function main() {
  if (!process.argv.includes('--confirm')) {
    console.error('Refusing to run without --confirm -- this wipes the target database first. Re-run with --confirm once you mean it.');
    process.exit(1);
  }

  console.log(`Target API: ${API_BASE_URL}`);
  const login = await api<{ accessToken: string }>('POST', '/auth/login', { phone: ADMIN_PHONE, password: ADMIN_PASSWORD });
  token = login.accessToken;

  console.log('== 1) Full wipe ==');
  const wipeResult = await api('POST', '/admin/full-wipe', { confirm: 'FULL-WIPE-EVERYTHING' });
  console.log(wipeResult);

  console.log('== 2) Restore Units of Measure ==');
  for (const u of DEFAULT_UNITS) await api('POST', '/units-of-measure', u);
  console.log(`units created: ${DEFAULT_UNITS.length}`);

  console.log('== 3) Create branch/location ==');
  const location = await api<{ id: string }>('POST', '/locations', { name: BRANCH_NAME, type: 'BRANCH' });
  console.log(`location id: ${location.id}`);

  console.log('== 4) Create ingredients ==');
  const ingredientIds: Record<string, string> = {};
  const ingredientUnits: Record<string, string> = {};
  const ingredientCosts: Record<string, number> = {};

  for (const ing of finalIngredients) {
    const created = await api<{ id: string }>('POST', '/ingredients', {
      name: ing.name,
      unit: ing.unit_code,
      kind: ing.kind,
      lowStockThreshold: 0,
    });
    ingredientIds[ing.name] = created.id;
    ingredientUnits[ing.name] = ing.unit_code;
    ingredientCosts[ing.name] = ing.unit_cost;
  }
  console.log(`matrix-based ingredients created: ${finalIngredients.length}`);

  for (const c of crepeComponents) {
    const created = await api<{ id: string }>('POST', '/ingredients', {
      name: c.name,
      unit: c.unit_code,
      kind: 'RAW_MATERIAL',
      lowStockThreshold: 0,
    });
    ingredientIds[c.name] = created.id;
    ingredientUnits[c.name] = c.unit_code;
    ingredientCosts[c.name] = c.unit_cost;
  }
  console.log(`crepe dough components created: ${crepeComponents.length}`);

  console.log('== 5) Set كريب (crepe dough) own recipe ==');
  const crepeId = ingredientIds['كريب'];
  const crepeLines = crepeComponents.map((c) => ({ ingredientId: ingredientIds[c.name], quantity: c.qty_per_bite }));
  await api('PUT', `/ingredients/${crepeId}/recipe`, { lines: crepeLines });
  console.log(`crepe recipe set with ${crepeLines.length} components`);

  console.log('== 6) Seed opening inventory batches (cost basis) ==');
  let batchCount = 0;
  for (const [name, id] of Object.entries(ingredientIds)) {
    const unit = ingredientUnits[name];
    const qty = DEFAULT_QTY[unit] ?? 100;
    const cost = ingredientCosts[name];
    await api('POST', '/inventory/adjustments', {
      locationId: location.id,
      ingredientId: id,
      quantity: qty,
      unitCost: cost,
      note: 'رصيد افتتاحي عند الاستيراد',
    });
    batchCount += 1;
  }
  console.log(`opening batches created: ${batchCount}`);

  console.log('== 7) Create menu items + their recipes ==');
  const menuItemIds: Record<string, string> = {};
  for (const m of menuItems) {
    const created = await api<{ id: string }>('POST', '/items', { name: m.name, category: m.category, price: m.price });
    menuItemIds[m.name] = created.id;
  }
  console.log(`menu items created: ${Object.keys(menuItemIds).length}`);

  let recipeLineCount = 0;
  const missing: Array<[string, string]> = [];
  for (const m of menuItems) {
    const lines: Array<{ ingredientId: string; quantity: number }> = [];
    for (const l of m.lines) {
      const ingredientId = ingredientIds[l.ingredient];
      if (!ingredientId) {
        missing.push([m.name, l.ingredient]);
        continue;
      }
      lines.push({ ingredientId, quantity: l.quantity });
    }
    await api('PUT', `/items/${menuItemIds[m.name]}/recipe`, { lines });
    recipeLineCount += lines.length;
  }
  console.log(`recipe lines set: ${recipeLineCount}`);
  if (missing.length) console.error('MISSING INGREDIENT MAPPINGS:', missing);

  console.log('== 8) Create delivery-app sales channels + item prices ==');
  const channelNames = Array.from(new Set(channelPrices.flatMap((r) => Object.keys(r.channels))));
  const channelIds: Record<string, string> = {};
  for (const name of channelNames) {
    const created = await api<{ id: string }>('POST', '/sales-channels', { name });
    channelIds[name] = created.id;
  }
  console.log(`sales channels created: ${channelNames.join('، ')}`);

  let channelPriceCount = 0;
  const missingChannelItems: string[] = [];
  for (const row of channelPrices) {
    const itemId = menuItemIds[row.item];
    if (!itemId) {
      missingChannelItems.push(row.item);
      continue;
    }
    for (const [channelName, price] of Object.entries(row.channels)) {
      await api('PUT', `/items/${itemId}/channel-prices/${channelIds[channelName]}`, { price });
      channelPriceCount += 1;
    }
  }
  console.log(`channel prices set: ${channelPriceCount}`);
  if (missingChannelItems.length) console.error('MISSING ITEM MAPPINGS FOR CHANNEL PRICES:', missingChannelItems);

  console.log('== DONE ==');
  console.log(`location_id: ${location.id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
