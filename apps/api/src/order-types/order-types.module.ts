import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrderTypesController } from './order-types.controller';
import { OrderTypesService } from './order-types.service';

@Module({
  imports: [AuthModule],
  controllers: [OrderTypesController],
  providers: [OrderTypesService],
  exports: [OrderTypesService],
})
export class OrderTypesModule {}
