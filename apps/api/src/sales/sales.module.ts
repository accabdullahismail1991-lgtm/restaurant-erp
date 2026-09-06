import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ZatcaModule } from '../zatca/zatca.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { ShiftsController } from './shifts.controller';
import { ShiftsService } from './shifts.service';

@Module({
  imports: [AuthModule, InventoryModule, ZatcaModule],
  controllers: [ShiftsController, OrdersController],
  providers: [ShiftsService, OrdersService],
})
export class SalesModule {}
