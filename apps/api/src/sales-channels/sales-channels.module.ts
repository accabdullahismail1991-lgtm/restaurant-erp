import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SalesChannelsController } from './sales-channels.controller';
import { SalesChannelsService } from './sales-channels.service';

@Module({
  imports: [AuthModule],
  controllers: [SalesChannelsController],
  providers: [SalesChannelsService],
  exports: [SalesChannelsService],
})
export class SalesChannelsModule {}
