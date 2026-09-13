import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PermissionsService {
  constructor(private readonly prisma: PrismaService) {}

  // A fixed catalog seeded by the app (each code gates a real
  // @RequirePermission-guarded route in code) -- read-only here on purpose,
  // there's no "create a new permission" concept since a UI-invented code
  // would gate nothing.
  findAll() {
    return this.prisma.permission.findMany({ select: { id: true, code: true, label: true }, orderBy: { code: 'asc' } });
  }
}
