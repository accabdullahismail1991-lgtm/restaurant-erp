import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { BranchesModule } from './branches/branches.module';
import { IngredientsModule } from './ingredients/ingredients.module';
import { ItemsModule } from './items/items.module';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';

// Phases 1-2 wired up: config, Prisma, auth/RBAC, users, branches,
// ingredients, items -- per docs/ARCHITECTURE.md's roadmap. Every other
// module under src/modules/* stays an unimplemented README stub until
// its own phase.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    UsersModule,
    BranchesModule,
    IngredientsModule,
    ItemsModule,
  ],
})
export class AppModule {}
