import { PrismaService } from '../src/prisma/prisma.service';

// Full reset of every domain table across every implemented module, in
// FK-safe order (children before parents). Jest runs all *.e2e-spec.ts
// files in one sequential process (--runInBand) against the same
// database, so whichever file happens to run first after an interrupted
// previous run is the one that pays for every OTHER suite's leftovers --
// a single shared, exhaustive reset avoids re-patching every existing
// file's cleanup each time a new module's table gains a foreign key into
// Ingredient/MenuItem/Location. Every suite calls this first in its own
// beforeAll, then separately cleans up (targeted or full, its choice)
// whatever User/Role/Permission rows it needs for login.
//
export async function resetDatabase(prisma: PrismaService) {
  await prisma.paymentMethod.deleteMany({});
  // Every existing suite that pays an order with method: 'CASH' and then
  // closes a shift expecting cash reconciliation to include it predates
  // PaymentMethod existing at all -- ShiftsService.close() now derives
  // "which methods count as cash" from PaymentMethod.isCash instead of a
  // hardcoded string, so those suites would silently break (expectedCash
  // stuck at the opening float) without this baseline restored right after
  // the wipe above, the same 3 defaults prisma/seed.ts gives local dev.
  await prisma.paymentMethod.createMany({
    data: [
      { code: 'CASH', name: 'كاش', isCash: true },
      { code: 'CARD', name: 'بطاقة', isCash: false },
      { code: 'WALLET', name: 'محفظة إلكترونية', isCash: false },
    ],
  });
  await prisma.generatedReport.deleteMany({});
  await prisma.approval.deleteMany({});
  await prisma.purchaseReturnLine.deleteMany({});
  await prisma.purchaseReturn.deleteMany({});
  await prisma.purchaseOrderLine.deleteMany({});
  await prisma.purchaseOrder.deleteMany({});
  await prisma.approvalRule.deleteMany({});
  await prisma.supplier.deleteMany({});
  await prisma.productionOrderLine.deleteMany({});
  await prisma.productionOrder.deleteMany({});
  await prisma.transferLine.deleteMany({});
  await prisma.transfer.deleteMany({});
  await prisma.stocktakeLine.deleteMany({});
  await prisma.stocktake.deleteMany({});
  await prisma.payment.deleteMany({});
  await prisma.orderReturnLine.deleteMany({});
  await prisma.orderReturn.deleteMany({});
  await prisma.orderLine.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.menuItemChannelPrice.deleteMany({});
  await prisma.salesChannel.deleteMany({});
  await prisma.promotion.deleteMany({});
  await prisma.table.deleteMany({});
  await prisma.loyaltyTransaction.deleteMany({});
  await prisma.customer.deleteMany({});
  await prisma.shift.deleteMany({});
  await prisma.stockMovement.deleteMany({});
  await prisma.inventoryBatch.deleteMany({});
  await prisma.inventoryBalance.deleteMany({});
  await prisma.recipeLine.deleteMany({});
  await prisma.menuItem.deleteMany({});
  await prisma.ingredient.deleteMany({});
  await prisma.userLocationScope.deleteMany({});
  await prisma.location.deleteMany({});
}
