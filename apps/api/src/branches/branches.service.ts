import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateLocationDto } from './dto/create-location.dto';
import { UpdateLocationDto } from './dto/update-location.dto';

@Injectable()
export class BranchesService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateLocationDto) {
    return this.prisma.location.create({ data: dto });
  }

  // A user with ZERO UserLocationScope rows is org-level scoped (per
  // docs/DECISIONS.md #16: scope can be branch/region/org) -- they see
  // every location. A user WITH scope rows sees only those locations.
  // This is the pattern every future module's list endpoint should
  // follow for its own location-scoped resource.
  private async scopedLocationIds(userId: string): Promise<string[] | null> {
    const scopes = await this.prisma.userLocationScope.findMany({ where: { userId }, select: { locationId: true } });
    if (scopes.length === 0) return null; // null = unrestricted
    return scopes.map((s) => s.locationId);
  }

  async findAll(userId: string) {
    const allowedIds = await this.scopedLocationIds(userId);
    return this.prisma.location.findMany({
      where: allowedIds ? { id: { in: allowedIds } } : undefined,
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string, userId: string) {
    const allowedIds = await this.scopedLocationIds(userId);
    if (allowedIds && !allowedIds.includes(id)) {
      throw new NotFoundException('الموقع غير موجود أو خارج نطاق صلاحيتك');
    }
    const location = await this.prisma.location.findUnique({ where: { id } });
    if (!location) throw new NotFoundException('الموقع غير موجود');
    return location;
  }

  async update(id: string, dto: UpdateLocationDto) {
    const existing = await this.prisma.location.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('الموقع غير موجود');
    return this.prisma.location.update({ where: { id }, data: dto });
  }
}
