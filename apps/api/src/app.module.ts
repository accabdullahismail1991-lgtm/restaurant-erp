import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AlertsModule } from './alerts/alerts.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuthModule } from './auth/auth.module';
import { BranchesModule } from './branches/branches.module';
import { CustomersModule } from './customers/customers.module';
import { IngredientsModule } from './ingredients/ingredients.module';
import { InventoryModule } from './inventory/inventory.module';
import { ItemsModule } from './items/items.module';
import { KitchenModule } from './kitchen/kitchen.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProductionModule } from './production/production.module';
import { PromotionsModule } from './promotions/promotions.module';
import { PurchasingModule } from './purchasing/purchasing.module';
import { ReportsModule } from './reports/reports.module';
import { ReturnsModule } from './returns/returns.module';
import { SalesModule } from './sales/sales.module';
import { SalesChannelsModule } from './sales-channels/sales-channels.module';
import { StocktakeModule } from './stocktake/stocktake.module';
import { TransfersModule } from './transfers/transfers.module';
import { UsersModule } from './users/users.module';

// Phases 1-7 (plus the Stocktake half of Phase 4) and the KDS slice of
// Phase 10 wired up: config, Prisma, auth/RBAC, users, branches,
// ingredients, items, inventory, sales, purchasing, production, transfers,
// stocktake, kitchen -- per docs/ARCHITECTURE.md's roadmap. Every other
// module under src/modules/* stays an unimplemented README stub until its
// own phase.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    UsersModule,
    BranchesModule,
    IngredientsModule,
    ItemsModule,
    InventoryModule,
    SalesModule,
    SalesChannelsModule,
    ReturnsModule,
    PurchasingModule,
    ProductionModule,
    TransfersModule,
    StocktakeModule,
    KitchenModule,
    PromotionsModule,
    CustomersModule,
    AnalyticsModule,
    ReportsModule,
    AlertsModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
