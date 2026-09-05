import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { BranchesModule } from './branches/branches.module';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';

// Phase 1 only wires up: config, Prisma, auth/RBAC, users, branches --
// per docs/ARCHITECTURE.md's roadmap. Every other module under
// src/modules/* stays an unimplemented README stub until its own phase.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    UsersModule,
    BranchesModule,
  ],
})
export class AppModule {}
