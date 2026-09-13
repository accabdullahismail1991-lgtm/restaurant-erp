import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CreateUnitDto } from './dto/create-unit.dto';
import { UpdateUnitDto } from './dto/update-unit.dto';
import { UnitsOfMeasureService } from './units-of-measure.service';

// Reuses ingredients.manage rather than a new permission code -- units of
// measure are purely a supporting catalog for Ingredients (docs/DECISIONS.md
// pattern: don't fragment authorization for a catalog that exists to serve
// one module).
@Controller('units-of-measure')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission('ingredients.manage')
export class UnitsOfMeasureController {
  constructor(private readonly units: UnitsOfMeasureService) {}

  @Get()
  findAll() {
    return this.units.findAll();
  }

  @Post()
  create(@Body() dto: CreateUnitDto) {
    return this.units.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateUnitDto) {
    return this.units.update(id, dto);
  }
}
