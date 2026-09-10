import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { BulkImportBodyDto } from '../common/bulk-import.util';
import { BranchesService } from './branches.service';
import { CreateLocationDto } from './dto/create-location.dto';
import { UpdateLocationDto } from './dto/update-location.dto';

@Controller('locations')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Post()
  @RequirePermission('branches.manage')
  create(@Body() dto: CreateLocationDto) {
    return this.branches.create(dto);
  }

  @Post('bulk-import')
  @RequirePermission('branches.manage')
  bulkImport(@Body() body: BulkImportBodyDto) {
    return this.branches.bulkImport(body.rows);
  }

  // Listing/reading a location only requires being logged in -- scope
  // (which locations you can SEE) is enforced inside the service, not
  // gated behind a separate permission. Writing requires branches.manage.
  @Get()
  findAll(@CurrentUser() user: { userId: string }) {
    return this.branches.findAll(user.userId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: { userId: string }) {
    return this.branches.findOne(id, user.userId);
  }

  @Patch(':id')
  @RequirePermission('branches.manage')
  update(@Param('id') id: string, @Body() dto: UpdateLocationDto) {
    return this.branches.update(id, dto);
  }
}
