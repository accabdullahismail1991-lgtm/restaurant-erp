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
  @RequirePermission('production.view')
  findAll(
    @CurrentUser() user: { userId: string },
    @Query('locationId') locationId?: string,
    @Query('status') status?: ProductionStatus,
  ) {
    return this.productionOrders.findAll(user.userId, locationId, status);
  }

  @Get(':id')
  @RequirePermission('production.view')
  findOne(@Param('id') id: string, @CurrentUser() user: { userId: string }) {
    return this.productionOrders.findOne(id, user.userId);
  }

  // Bulk-finishes every PLANNED order whose inputs are now fully in stock
  // -- see ProductionOrdersService.processReady()'s comment for why this
  // is safe to call at any time (it just skips whatever still isn't
  // available, nothing partial ever gets consumed).
  @Post('process-ready')
  @HttpCode(200)
  @RequirePermission('production.manage')
  processReady(@CurrentUser() user: { userId: string }, @Query('locationId') locationId?: string) {
    return this.productionOrders.processReady(user.userId, locationId);
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
