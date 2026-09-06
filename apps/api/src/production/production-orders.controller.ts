import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ProductionStatus } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CreateProductionOrderDto } from './dto/create-production-order.dto';
import { ProductionOrdersService } from './production-orders.service';

@Controller('production-orders')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ProductionOrdersController {
  constructor(private readonly productionOrders: ProductionOrdersService) {}

  @Post()
  @RequirePermission('production.manage')
  create(@Body() dto: CreateProductionOrderDto, @CurrentUser() user: { userId: string }) {
    return this.productionOrders.create(dto, user.userId);
  }

  @Get()
  findAll(
    @CurrentUser() user: { userId: string },
    @Query('locationId') locationId?: string,
    @Query('status') status?: ProductionStatus,
  ) {
    return this.productionOrders.findAll(user.userId, locationId, status);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: { userId: string }) {
    return this.productionOrders.findOne(id, user.userId);
  }

  @Post(':id/start')
  @HttpCode(200)
  @RequirePermission('production.manage')
  start(@Param('id') id: string, @CurrentUser() user: { userId: string }) {
    return this.productionOrders.start(id, user.userId);
  }

  @Post(':id/complete')
  @HttpCode(200)
  @RequirePermission('production.manage')
  complete(@Param('id') id: string, @CurrentUser() user: { userId: string }) {
    return this.productionOrders.complete(id, user.userId);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('production.manage')
  cancel(@Param('id') id: string, @CurrentUser() user: { userId: string }) {
    return this.productionOrders.cancel(id, user.userId);
  }
}
