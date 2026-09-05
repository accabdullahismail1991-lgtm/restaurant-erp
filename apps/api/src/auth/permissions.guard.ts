import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { PERMISSION_KEY } from './require-permission.decorator';

// Runs AFTER JwtAuthGuard (see the ordering in each controller's
// @UseGuards(JwtAuthGuard, PermissionsGuard)) -- it trusts request.user is
// already populated. A route with no @RequirePermission() is allowed
// through untouched (being logged in is enough); this guard only ever
// adds a requirement, never relaxes JwtAuthGuard's own check.
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredCode = this.reflector.getAllAndOverride<string | undefined>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredCode) return true;

    const request = context.switchToHttp().getRequest();
    const userId: string | undefined = request.user?.userId;
    if (!userId) return false;

    const match = await this.prisma.rolePermission.findFirst({
      where: {
        permission: { code: requiredCode },
        role: { users: { some: { userId } } },
      },
      select: { roleId: true },
    });
    if (!match) {
      throw new ForbiddenException(`صلاحية "${requiredCode}" مطلوبة لتنفيذ هذا الإجراء`);
    }
    return true;
  }
}
