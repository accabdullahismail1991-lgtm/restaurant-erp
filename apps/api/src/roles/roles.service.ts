import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';

const SELECT = {
  id: true,
  name: true,
  description: true,
  permissions: { select: { permission: { select: { id: true, code: true, label: true } } } },
  _count: { select: { users: true } },
} as const;

function present(role: any) {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    permissions: role.permissions.map((p: any) => p.permission),
    userCount: role._count.users,
  };
}

@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  // Permissions are a fixed catalog baked into the app (each code gates a
  // real @RequirePermission-guarded route) -- a role can only ever be
  // assigned codes that actually exist, never an arbitrary made-up string.
  private async resolvePermissionIds(codes: string[]) {
    if (!codes.length) return [];
    const found = await this.prisma.permission.findMany({ where: { code: { in: codes } } });
    if (found.length !== new Set(codes).size) {
      throw new BadRequestException('أحد رموز الصلاحيات المُختارة غير موجود');
    }
    return found.map((p) => p.id);
  }

  async create(dto: CreateRoleDto) {
    const existing = await this.prisma.role.findUnique({ where: { name: dto.name } });
    if (existing) throw new ConflictException('يوجد دور بهذا الاسم بالفعل');
    const permissionIds = await this.resolvePermissionIds(dto.permissionCodes);
    const role = await this.prisma.role.create({
      data: {
        name: dto.name,
        description: dto.description,
        permissions: permissionIds.length ? { create: permissionIds.map((permissionId) => ({ permissionId })) } : undefined,
      },
      select: SELECT,
    });
    return present(role);
  }

  async findAll() {
    const roles = await this.prisma.role.findMany({ select: SELECT, orderBy: { name: 'asc' } });
    return roles.map(present);
  }

  async findOne(id: string) {
    const role = await this.prisma.role.findUnique({ where: { id }, select: SELECT });
    if (!role) throw new NotFoundException('الدور غير موجود');
    return present(role);
  }

  async update(id: string, dto: UpdateRoleDto) {
    const existing = await this.prisma.role.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('الدور غير موجود');
    if (dto.name && dto.name !== existing.name) {
      const nameClash = await this.prisma.role.findUnique({ where: { name: dto.name } });
      if (nameClash) throw new ConflictException('يوجد دور بهذا الاسم بالفعل');
    }

    const permissionIds = dto.permissionCodes ? await this.resolvePermissionIds(dto.permissionCodes) : undefined;
    const role = await this.prisma.$transaction(async (tx) => {
      if (permissionIds) {
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        if (permissionIds.length) {
          await tx.rolePermission.createMany({ data: permissionIds.map((permissionId) => ({ roleId: id, permissionId })) });
        }
      }
      return tx.role.update({
        where: { id },
        data: { name: dto.name, description: dto.description },
        select: SELECT,
      });
    });
    return present(role);
  }

  // Blocked while any user still holds this role -- deleting it out from
  // under them would silently strip their access with no trace of why,
  // the same "don't mutate what's actively in use" caution the combo
  // module's slot/option immutability follows. RolePermission rows are
  // just this role's own config, so those are always safe to drop first.
  async remove(id: string) {
    const role = await this.prisma.role.findUnique({ where: { id }, include: { _count: { select: { users: true } } } });
    if (!role) throw new NotFoundException('الدور غير موجود');
    if (role._count.users > 0) {
      throw new BadRequestException(`لا يمكن حذف دور مُسند إلى ${role._count.users} مستخدم/مستخدمين -- أزل الدور منهم أولًا`);
    }
    await this.prisma.$transaction([
      this.prisma.rolePermission.deleteMany({ where: { roleId: id } }),
      this.prisma.role.delete({ where: { id } }),
    ]);
  }
}
