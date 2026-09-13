import { PrismaService } from '../prisma/prisma.service';

// Same DB check PermissionsGuard already does for a whole route, pulled
// out so a service can gate just ONE field/branch of an otherwise-open
// endpoint (e.g. OrdersService.create() allowing a manual discountTotal
// only for users with pos.apply_discount) without needing a separate
// controller route + @RequirePermission() just for that one case.
export async function userHasPermission(prisma: PrismaService, userId: string, code: string): Promise<boolean> {
  const match = await prisma.rolePermission.findFirst({
    where: { permission: { code }, role: { users: { some: { userId } } } },
    select: { roleId: true },
  });
  return !!match;
}
