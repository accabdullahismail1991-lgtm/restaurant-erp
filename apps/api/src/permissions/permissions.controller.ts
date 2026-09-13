import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { PermissionsService } from './permissions.service';

@Controller('permissions')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission('users.manage')
export class PermissionsController {
  constructor(private readonly permissions: PermissionsService) {}

  @Get()
  findAll() {
    return this.permissions.findAll();
  }
}
