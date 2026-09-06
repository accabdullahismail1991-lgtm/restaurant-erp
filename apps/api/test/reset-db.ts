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
// NOTE for whoever builds Stocktake next: those tables
// (Stocktake/StocktakeLine) also FK into Ingredient/Location and
// currently sit empty because nothing writes to them yet -- add their
// deleteMany calls here, in the same children-before-parents order, the
// day a suite starts creating rows in them.
export async function resetDatabase(prisma: PrismaService) {
  await prisma.approval.deleteMany({});
  await prisma.purchaseOrderLine.deleteMany({});
  await prisma.purchaseOrder.deleteMany({});
  await prisma.approvalRule.deleteMany({});
  await prisma.supplier.deleteMany({});
  await prisma.productionOrderLine.deleteMany({});
  await prisma.productionOrder.deleteMany({});
  await prisma.transferLine.deleteMany({});
  await prisma.transfer.deleteMany({});
  await prisma.payment.deleteMany({});
  await prisma.orderLine.deleteMany({});
  await prisma.order.deleteMany({});
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
