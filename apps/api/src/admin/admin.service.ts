import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  // Clears the product catalog (ingredients + recipes + menu items + combos)
  // and everything transactional that references them -- FK reality (recipe
  // lines, order lines, inventory batches/movements, purchase/production/
  // transfer/stocktake lines all point at Ingredient/MenuItem with no cascade)
  // means "delete the catalog" can only ever mean "delete the catalog AND its
  // full usage history", not the catalog alone. What it deliberately keeps:
  // branches, suppliers, customers/loyalty, shifts, sales channels,
  // promotions, payment methods, approval rules, and every user/role/
  // permission -- the operational setup an admin would have to rebuild by
  // hand, as opposed to product data they're about to re-import in bulk.
  // The narrower sibling of resetMasterData() below -- clears every
  // transaction/operational document (orders, shifts, purchase/production/
  // transfer orders, stocktakes, and the inventory batches/movements they
  // produced) while leaving the product catalog itself untouched: branches,
  // ingredients, recipes, menu items, and combos survive intact. Meant for
  // "wipe test invoices/sessions and start clean on the same setup" rather
  // than resetMasterData()'s "clear the catalog too, I'm about to re-import
  // it" use case. Same FK-driven ordering resetMasterData() already uses,
  // just stopping short of the catalog tables themselves.
  async resetTransactions() {
    return this.prisma.$transaction(async (tx) => {
      await tx.comboSelection.deleteMany({});
      await tx.orderReturnLine.deleteMany({});
      await tx.orderReturn.deleteMany({});
      await tx.payment.deleteMany({});
      await tx.orderActivityLog.deleteMany({});
      await tx.orderLine.deleteMany({});
      const orders = await tx.order.deleteMany({});
      await tx.productionOrderLine.deleteMany({});
      const productionOrders = await tx.productionOrder.deleteMany({});
      await tx.approval.deleteMany({});
      await tx.purchaseOrderLine.deleteMany({});
      const purchaseOrders = await tx.purchaseOrder.deleteMany({});
      await tx.purchaseReturnLine.deleteMany({});
      await tx.purchaseReturn.deleteMany({});
      await tx.transferLine.deleteMany({});
      const transfers = await tx.transfer.deleteMany({});
      await tx.stocktakeLine.deleteMany({});
      const stocktakes = await tx.stocktake.deleteMany({});
      const movements = await tx.stockMovement.deleteMany({});
      await tx.inventoryBatch.deleteMany({});
      await tx.inventoryBalance.deleteMany({});
      await tx.dayClose.deleteMany({});
      await tx.dailyInvoiceCounter.deleteMany({});
      await tx.loyaltyTransaction.deleteMany({});
      const shifts = await tx.shift.deleteMany({});

      return {
        orders: orders.count,
        productionOrders: productionOrders.count,
        purchaseOrders: purchaseOrders.count,
        transfers: transfers.count,
        stocktakes: stocktakes.count,
        stockMovements: movements.count,
        shifts: shifts.count,
      };
    });
  }

  async resetMasterData() {
    return this.prisma.$transaction(async (tx) => {
      await tx.comboSelection.deleteMany({});
      await tx.orderReturnLine.deleteMany({});
      await tx.orderReturn.deleteMany({});
      await tx.payment.deleteMany({});
      await tx.orderActivityLog.deleteMany({});
      await tx.orderLine.deleteMany({});
      const orders = await tx.order.deleteMany({});
      await tx.comboSlotOption.deleteMany({});
      await tx.comboSlot.deleteMany({});
      const combos = await tx.comboMeal.deleteMany({});
      await tx.menuItemChannelPrice.deleteMany({});
      await tx.productionOrderLine.deleteMany({});
      const productionOrders = await tx.productionOrder.deleteMany({});
      // Approval rows point at PurchaseOrder/Stocktake, both being wiped
      // below in the same pass -- every one of them is about to be orphaned
      // regardless of which document type it decided on.
      await tx.approval.deleteMany({});
      await tx.purchaseOrderLine.deleteMany({});
      const purchaseOrders = await tx.purchaseOrder.deleteMany({});
      await tx.purchaseReturnLine.deleteMany({});
      await tx.purchaseReturn.deleteMany({});
      await tx.transferLine.deleteMany({});
      const transfers = await tx.transfer.deleteMany({});
      await tx.stocktakeLine.deleteMany({});
      const stocktakes = await tx.stocktake.deleteMany({});
      const movements = await tx.stockMovement.deleteMany({});
      await tx.inventoryBatch.deleteMany({});
      await tx.inventoryBalance.deleteMany({});
      await tx.recipeLine.deleteMany({});
      const menuItems = await tx.menuItem.deleteMany({});
      const ingredients = await tx.ingredient.deleteMany({});

      return {
        ingredients: ingredients.count,
        menuItems: menuItems.count,
        combos: combos.count,
        orders: orders.count,
        productionOrders: productionOrders.count,
        purchaseOrders: purchaseOrders.count,
        transfers: transfers.count,
        stocktakes: stocktakes.count,
        stockMovements: movements.count,
      };
    });
  }

  // Everything resetMasterData() does, PLUS every remaining piece of
  // operational/business data -- suppliers, customers/loyalty, shifts,
  // tables, sales channels, promotions, approval rules, day closes,
  // generated report files, unit-of-measure catalog, and branches
  // themselves. Deliberately still stops short of touching User/Role/
  // Permission/RolePermission/UserRole: wiping those would lock the admin
  // performing this action out of the very system they're about to
  // re-populate, with no way back in short of re-running the seed script.
  async fullWipe() {
    const masterCounts = await this.resetMasterData();

    return this.prisma.$transaction(async (tx) => {
      await tx.dayClose.deleteMany({});
      await tx.dailyInvoiceCounter.deleteMany({});
      await tx.loyaltyTransaction.deleteMany({});
      const customers = await tx.customer.deleteMany({});
      await tx.shift.deleteMany({});
      await tx.table.deleteMany({});
      await tx.promotion.deleteMany({});
      await tx.salesChannel.deleteMany({});
      const suppliers = await tx.supplier.deleteMany({});
      await tx.approvalRule.deleteMany({});
      await tx.generatedReport.deleteMany({});
      await tx.unitOfMeasure.deleteMany({});
      await tx.userLocationScope.deleteMany({});
      const locations = await tx.location.deleteMany({});

      // Reset payment methods back to the same baseline prisma/seed.ts
      // gives a fresh install, rather than leaving the table empty --
      // there is no meaningful "re-import your own payment methods" flow,
      // unlike ingredients/menu items.
      await tx.paymentMethod.deleteMany({});
      await tx.paymentMethod.createMany({
        data: [
          { code: 'CASH', name: 'كاش', isCash: true },
          { code: 'CARD', name: 'شبكة (بطاقة)', isCash: false },
          { code: 'WALLET', name: 'محفظة إلكترونية', isCash: false },
          { code: 'STAFF_MEAL', name: 'وجبات الموظفين', isCash: false },
        ],
      });

      return {
        ...masterCounts,
        customers: customers.count,
        suppliers: suppliers.count,
        locations: locations.count,
      };
    });
  }
}
