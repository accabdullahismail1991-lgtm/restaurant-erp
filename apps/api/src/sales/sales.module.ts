import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CustomersModule } from '../customers/customers.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PaymentMethodsModule } from '../payment-methods/payment-methods.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { ZatcaModule } from '../zatca/zatca.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { ShiftsController } from './shifts.controller';
import { ShiftsService } from './shifts.service';

@Module({
  imports: [AuthModule, InventoryModule, ZatcaModule, PromotionsModule, CustomersModule, PaymentMethodsModule],
  controllers: [ShiftsController, OrdersController],
  providers: [ShiftsService, OrdersService],
})
export class SalesModule {}
