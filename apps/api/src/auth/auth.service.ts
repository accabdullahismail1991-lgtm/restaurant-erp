import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from './jwt-payload.type';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async validateCredentials(phone: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { phone } });
    // Same "invalid credentials" message whether the phone doesn't exist
    // or the password is wrong -- never reveal which one it was.
    if (!user || !user.isActive) throw new UnauthorizedException('رقم الجوال أو كلمة المرور غير صحيحة');
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('رقم الجوال أو كلمة المرور غير صحيحة');
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

  async login(phone: string, password: string) {
    const user = await this.validateCredentials(phone, password);
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
}
