import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { BranchesModule } from './branches/branches.module';
import { IngredientsModule } from './ingredients/ingredients.module';
import { InventoryModule } from './inventory/inventory.module';
import { ItemsModule } from './items/items.module';
import { PrismaModule } from './prisma/prisma.module';
import { SalesModule } from './sales/sales.module';
import { UsersModule } from './users/users.module';

// Phases 1-4 wired up: config, Prisma, auth/RBAC, users, branches,
// ingredients, items, inventory, sales -- per docs/ARCHITECTURE.md's
// roadmap. Every other module under src/modules/* stays an unimplemented
// README stub until its own phase.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    UsersModule,
    BranchesModule,
    IngredientsModule,
    ItemsModule,
    InventoryModule,
    SalesModule,
  ],
})
export class AppModule {}
