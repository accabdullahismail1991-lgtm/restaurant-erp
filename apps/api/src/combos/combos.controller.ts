import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CombosService } from './combos.service';
import { CreateComboDto } from './dto/create-combo.dto';
import { UpdateComboDto } from './dto/update-combo.dto';

@Controller('combos')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class CombosController {
  constructor(private readonly combos: CombosService) {}

  @Post()
  @RequirePermission('combos.manage')
  create(@Body() dto: CreateComboDto) {
    return this.combos.create(dto);
  }

  @Get()
  findAll() {
    return this.combos.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.combos.findOne(id);
  }

  @Patch(':id')
  @RequirePermission('combos.manage')
  update(@Param('id') id: string, @Body() dto: UpdateComboDto) {
    return this.combos.update(id, dto);
  }
}
