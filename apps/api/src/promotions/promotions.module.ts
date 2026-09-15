import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrderTypesModule } from '../order-types/order-types.module';
import { PromotionsController } from './promotions.controller';
import { PromotionsService } from './promotions.service';

@Module({
  imports: [AuthModule, OrderTypesModule],
  controllers: [PromotionsController],
  providers: [PromotionsService],
  exports: [PromotionsService],
})
export class PromotionsModule {}
