import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

// Never select passwordHash back out to an API response.
const SAFE_SELECT = {
  id: true,
  name: true,
  phone: true,
  isActive: true,
  createdAt: true,
  roles: { select: { role: { select: { id: true, name: true } } } },
  locationScopes: { select: { location: { select: { id: true, name: true, type: true } } } },
} as const;

function present(user: any) {
  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    isActive: user.isActive,
    createdAt: user.createdAt,
    roles: user.roles.map((r: any) => r.role),
    locations: user.locationScopes.map((s: any) => s.location),
  };
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateUserDto) {
    const existing = await this.prisma.user.findUnique({ where: { phone: dto.phone } });
    if (existing) throw new ConflictException('رقم الجوال مستخدم بالفعل');
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = await this.prisma.user.create({
      data: {
        name: dto.name,
        phone: dto.phone,
        passwordHash,
        roles: dto.roleIds?.length ? { create: dto.roleIds.map((roleId) => ({ roleId })) } : undefined,
        locationScopes: dto.locationIds?.length
          ? { create: dto.locationIds.map((locationId) => ({ locationId })) }
          : undefined,
      },
      select: SAFE_SELECT,
    });
    return present(user);
  }

  async findAll() {
    const users = await this.prisma.user.findMany({ select: SAFE_SELECT, orderBy: { createdAt: 'desc' } });
    return users.map(present);
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: SAFE_SELECT });
    if (!user) throw new NotFoundException('المستخدم غير موجود');
    return present(user);
  }

  async update(id: string, dto: UpdateUserDto) {
    const existing = await this.prisma.user.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('المستخدم غير موجود');

    // Roles/location scopes are join tables (composite keys, no own id) --
    // simplest correct way to "replace the set" is delete-then-recreate
    // inside one transaction, rather than diffing.
    const user = await this.prisma.$transaction(async (tx) => {
      if (dto.roleIds) {
        await tx.userRole.deleteMany({ where: { userId: id } });
        if (dto.roleIds.length) {
          await tx.userRole.createMany({ data: dto.roleIds.map((roleId) => ({ userId: id, roleId })) });
        }
      }
      if (dto.locationIds) {
        await tx.userLocationScope.deleteMany({ where: { userId: id } });
        if (dto.locationIds.length) {
          await tx.userLocationScope.createMany({
            data: dto.locationIds.map((locationId) => ({ userId: id, locationId })),
          });
        }
      }
      return tx.user.update({
        where: { id },
        data: {
          name: dto.name,
          isActive: dto.isActive,
        },
        select: SAFE_SELECT,
      });
    });
    return present(user);
  }
}
