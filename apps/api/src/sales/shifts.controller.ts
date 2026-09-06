import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { CloseShiftDto, OpenShiftDto } from './dto/shift.dto';
import { ShiftsService } from './shifts.service';

@Controller('shifts')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  @Post()
  open(@Body() dto: OpenShiftDto, @CurrentUser() user: { userId: string }) {
    return this.shifts.open(dto, user.userId);
  }

  @Get()
  findAll(
    @CurrentUser() user: { userId: string },
    @Query('locationId') locationId?: string,
    @Query('openOnly') openOnly?: string,
  ) {
    return this.shifts.findAll(user.userId, locationId, openOnly === 'true');
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: { userId: string }) {
    return this.shifts.findOne(id, user.userId);
  }

  // Not creating a new resource -- transitions an existing shift's state.
  @Post(':id/close')
  @HttpCode(200)
  close(@Param('id') id: string, @Body() dto: CloseShiftDto, @CurrentUser() user: { userId: string }) {
    return this.shifts.close(id, dto, user.userId);
  }
}
