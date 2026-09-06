import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ApprovalRulesController } from './approval-rules.controller';
import { ApprovalRulesService } from './approval-rules.service';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { PurchaseOrdersService } from './purchase-orders.service';
import { SuppliersController } from './suppliers.controller';
import { SuppliersService } from './suppliers.service';

@Module({
  imports: [AuthModule, InventoryModule],
  controllers: [SuppliersController, ApprovalRulesController, PurchaseOrdersController],
  providers: [SuppliersService, ApprovalRulesService, PurchaseOrdersService],
  // ApprovalRulesService is the Approval Matrix engine (docs/DECISIONS.md
  // #8) -- exported so any OTHER document type routed through the same
  // matrix (e.g. Stocktake's STOCKTAKE_ADJUSTMENT) reuses it instead of
  // re-deriving the tie-break logic.
  exports: [ApprovalRulesService],
})
export class PurchasingModule {}
