import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CreateReturnDto } from './dto/create-return.dto';
import { ReturnsService } from './returns.service';

@Controller('returns')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  @Get()
  findAll(@CurrentUser() user: { userId: string }, @Query('locationId') locationId?: string) {
    return this.returns.findAll(user.userId, locationId);
  }

  @Get('order/:orderId/returnable-lines')
  returnableLines(@Param('orderId') orderId: string, @CurrentUser() user: { userId: string }) {
    return this.returns.returnableLines(orderId, user.userId);
  }

  @Post()
  @RequirePermission('pos.return_order')
  create(@Body() dto: CreateReturnDto, @CurrentUser() user: { userId: string }) {
    return this.returns.create(dto, user.userId);
  }
}
