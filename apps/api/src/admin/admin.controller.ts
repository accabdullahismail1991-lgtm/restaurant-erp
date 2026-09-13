import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { AdminService } from './admin.service';
import { ConfirmFullWipeDto, ConfirmResetMasterDataDto } from './dto/confirm-reset.dto';

// A single, deliberately narrow permission (system.reset_data) gates both
// endpoints -- neither is included in the "مدير فرع" (branch manager) role
// seeded by prisma/seed.ts, only "مدير النظام" (full system admin).
@Controller('admin')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission('system.reset_data')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Post('reset-master-data')
  resetMasterData(@Body() _dto: ConfirmResetMasterDataDto) {
    return this.admin.resetMasterData();
  }

  @Post('full-wipe')
  fullWipe(@Body() _dto: ConfirmFullWipeDto) {
    return this.admin.fullWipe();
  }
}
