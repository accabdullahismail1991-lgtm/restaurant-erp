import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from './jwt-payload.type';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  // `identifier` is whatever the client sent in the login form's "phone"
  // field -- accepted as EITHER the user's phone number OR their optional
  // username (User.username), so no wire-shape change is needed for
  // existing clients (pos-web, e2e tests) that only ever send a phone
  // number here.
  async validateCredentials(identifier: string, password: string) {
    const user = await this.prisma.user.findFirst({ where: { OR: [{ phone: identifier }, { username: identifier }] } });
    // Same "invalid credentials" message whether the identifier doesn't
    // exist or the password is wrong -- never reveal which one it was.
    if (!user || !user.isActive) throw new UnauthorizedException('رقم الجوال/اسم المستخدم أو كلمة المرور غير صحيحة');
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('رقم الجوال/اسم المستخدم أو كلمة المرور غير صحيحة');
    return user;
  }

  async issueTokens(userId: string) {
    const accessPayload: JwtPayload = { sub: userId, type: 'access' };
    const refreshPayload: JwtPayload = { sub: userId, type: 'refresh' };
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(accessPayload, { expiresIn: this.config.get<string>('JWT_ACCESS_EXPIRES_IN', '15m') }),
      this.jwt.signAsync(refreshPayload, { expiresIn: this.config.get<string>('JWT_REFRESH_EXPIRES_IN', '7d') }),
    ]);
    return { accessToken, refreshToken };
  }

  async login(identifier: string, password: string) {
    const user = await this.validateCredentials(identifier, password);
    return this.issueTokens(user.id);
  }

  async refresh(refreshToken: string) {
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(refreshToken);
    } catch {
      throw new UnauthorizedException('refresh token غير صالح أو منتهي');
    }
    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('يجب استخدام refresh token صالح');
    }
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.isActive) throw new UnauthorizedException('المستخدم غير موجود أو معطّل');
    // Refresh token is NOT rotated here -- a known simplification for this
    // first phase (see docs/DECISIONS.md's spirit: ship the simplest
    // correct thing first). Rotating refresh tokens (issue a new one and
    // invalidate the old) is a real hardening step for a later pass, once
    // there's a token-revocation store to check against.
    return this.issueTokens(user.id);
  }

  // Every logged-in user needs to know their OWN permission set to render
  // their own UI correctly (e.g. hiding nav links to screens they'd just
  // get a 403 from) -- no @RequirePermission gate here, since there is no
  // sensible permission that could ever block a user from reading their
  // own profile/permissions.
  async me(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        phone: true,
        username: true,
        roles: { select: { role: { select: { permissions: { select: { permission: { select: { code: true } } } } } } } },
      },
    });
    const permissions = Array.from(
      new Set(user.roles.flatMap((r) => r.role.permissions.map((p) => p.permission.code))),
    );
    return { id: user.id, name: user.name, phone: user.phone, username: user.username, permissions };
  }

  // Public (no auth) -- consumes a one-time token an admin generated via
  // UsersService.createPasswordResetLink() and forwarded to the user
  // themselves. Looked up by the token's hash, never the raw value (same
  // pattern as never storing a plaintext password). A generic message
  // either way (expired vs. already-used vs. never-existed) since none of
  // that distinction is this endpoint's business to reveal to whoever holds
  // the link.
  async resetPassword(token: string, newPassword: string) {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const record = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash } });
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw new BadRequestException('رابط الاستعادة غير صالح أو منتهي الصلاحية -- اطلب رابطًا جديدًا من مدير النظام');
    }
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: record.userId }, data: { passwordHash } }),
      this.prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    ]);
    return { ok: true };
  }
}
