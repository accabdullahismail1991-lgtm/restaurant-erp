import { PrismaService } from '../prisma/prisma.service';

// Shared by every module with a location-scoped resource (branches, shifts,
// orders, inventory...). A user with ZERO UserLocationScope rows is
// org-level (sees/acts on every location); a user WITH scope rows is
// restricted to those locations. See branches.service.ts's original
// comment -- this is that same pattern, pulled out so every module applies
// it identically instead of re-deriving it. Callers throw their own
// NestJS exception (NotFoundException/ForbiddenException) based on the
// result, same as BranchesService already did.
export async function scopedLocationIds(prisma: PrismaService, userId: string): Promise<string[] | null> {
  const scopes = await prisma.userLocationScope.findMany({ where: { userId }, select: { locationId: true } });
  if (scopes.length === 0) return null; // null = unrestricted
  return scopes.map((s) => s.locationId);
}
