import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PurchasingModule } from '../purchasing/purchasing.module';
import { StocktakesController } from './stocktakes.controller';
import { StocktakesService } from './stocktakes.service';

@Module({
  imports: [AuthModule, InventoryModule, PurchasingModule],
  controllers: [StocktakesController],
  providers: [StocktakesService],
})
export class StocktakeModule {}
