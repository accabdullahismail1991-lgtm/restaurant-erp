import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

// Never select passwordHash back out to an API response.
const SAFE_SELECT = {
  id: true,
  name: true,
  phone: true,
  username: true,
  email: true,
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
    username: user.username,
    email: user.email,
    isActive: user.isActive,
    createdAt: user.createdAt,
    roles: user.roles.map((r: any) => r.role),
    locations: user.locationScopes.map((s: any) => s.location),
  };
}

// 30 minutes felt right for a token that isn't emailed automatically --
// long enough for an admin to generate it and hand it off (WhatsApp, in
// person) before it expires, short enough that a stale/forwarded link
// stops working reasonably soon.
const PASSWORD_RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
function hashResetToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  // AuthService.validateCredentials() looks a login identifier up against
  // BOTH the phone and username columns -- a value can't be allowed to sit
  // in one user's phone and another's username at the same time, or login
  // by that value would be ambiguous. Checked for both fields whenever
  // either one is being set, excluding the user being updated (if any).
  private async assertIdentifierAvailable(value: string, excludeUserId?: string) {
    const conflict = await this.prisma.user.findFirst({
      where: { OR: [{ phone: value }, { username: value }], ...(excludeUserId ? { id: { not: excludeUserId } } : {}) },
    });
    if (conflict) throw new ConflictException('رقم الجوال/اسم المستخدم مستخدم بالفعل');
  }
  private async assertEmailAvailable(email: string, excludeUserId?: string) {
    const conflict = await this.prisma.user.findFirst({
      where: { email, ...(excludeUserId ? { id: { not: excludeUserId } } : {}) },
    });
    if (conflict) throw new ConflictException('هذا البريد الإلكتروني مستخدم بالفعل');
  }

  async create(dto: CreateUserDto) {
    await this.assertIdentifierAvailable(dto.phone);
    if (dto.username) await this.assertIdentifierAvailable(dto.username);
    if (dto.email) await this.assertEmailAvailable(dto.email);
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = await this.prisma.user.create({
      data: {
        name: dto.name,
        phone: dto.phone,
        username: dto.username,
        email: dto.email,
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
    if (dto.username) await this.assertIdentifierAvailable(dto.username, id);
    if (dto.email) await this.assertEmailAvailable(dto.email, id);

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
          username: dto.username,
          email: dto.email,
          passwordHash: dto.password ? await bcrypt.hash(dto.password, 10) : undefined,
        },
        select: SAFE_SELECT,
      });
    });
    return present(user);
  }

  // Generates a one-time password-reset token for `id`, issued by the admin
  // `createdByUserId`. Only the raw token is ever returned to the caller --
  // it is NOT recoverable afterwards, only its hash is stored (see
  // PasswordResetToken schema comment). Deletes this user's other unused
  // tokens first, so at most one link is ever valid at a time.
  async createPasswordResetLink(id: string, createdByUserId: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('المستخدم غير موجود');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS);
    await this.prisma.$transaction([
      this.prisma.passwordResetToken.deleteMany({ where: { userId: id, usedAt: null } }),
      this.prisma.passwordResetToken.create({
        data: { userId: id, tokenHash: hashResetToken(token), createdByUserId, expiresAt },
      }),
    ]);
    return { token, expiresAt };
  }
}
