import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { RolesService } from './roles.service';

// Gated behind users.manage -- the same permission the seed data already
// labels "إدارة المستخدمين والأدوار" (managing users AND roles), rather
// than introducing a separate roles.manage code.
@Controller('roles')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission('users.manage')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Post()
  create(@Body() dto: CreateRoleDto) {
    return this.roles.create(dto);
  }

  @Get()
  findAll() {
    return this.roles.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.roles.findOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateRoleDto) {
    return this.roles.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.roles.remove(id);
  }
}
