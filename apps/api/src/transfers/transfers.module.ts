import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InventoryModule } from '../inventory/inventory.module';
import { TransfersController } from './transfers.controller';
import { TransfersService } from './transfers.service';

@Module({
  imports: [AuthModule, InventoryModule],
  controllers: [TransfersController],
  providers: [TransfersService],
})
export class TransfersModule {}
