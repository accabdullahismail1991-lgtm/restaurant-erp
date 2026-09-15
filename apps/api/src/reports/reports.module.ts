import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AuthModule } from '../auth/auth.module';
import { OrderTypesModule } from '../order-types/order-types.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [AuthModule, AnalyticsModule, OrderTypesModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
