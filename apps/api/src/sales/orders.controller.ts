import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CreateOrderDto } from './dto/create-order.dto';
import { PayOrderDto } from './dto/pay-order.dto';
import { OrdersService } from './orders.service';

@Controller('orders')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  // Creating, listing, viewing and paying an order are base cashier
  // operations -- no extra permission beyond being logged in (same as the
  // seed.ts comment said before this module existed). Only voiding needs
  // pos.void_order.
  @Post()
  create(@Body() dto: CreateOrderDto, @CurrentUser() user: { userId: string }) {
    return this.orders.create(dto, user.userId);
  }

  @Get()
  findAll(
    @CurrentUser() user: { userId: string },
    @Query('locationId') locationId?: string,
    @Query('status') status?: OrderStatus,
  ) {
    return this.orders.findAll(user.userId, locationId, status);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: { userId: string }) {
    return this.orders.findOne(id, user.userId);
  }

  // Neither of these creates a new resource -- they transition an
  // existing order's state -- so 200 rather than Nest's POST default 201.
  @Post(':id/pay')
  @HttpCode(200)
  pay(@Param('id') id: string, @Body() dto: PayOrderDto, @CurrentUser() user: { userId: string }) {
    return this.orders.pay(id, dto, user.userId);
  }

  @Post(':id/void')
  @HttpCode(200)
  @RequirePermission('pos.void_order')
  void(@Param('id') id: string, @CurrentUser() user: { userId: string }) {
    return this.orders.void(id, user.userId);
  }

  // The invoice itself (XML/hash/signature/QR) is already generated and
  // signed locally at pay() time -- this only attempts the separate step
  // of reporting it to ZATCA's real platform, which honestly reports back
  // that it isn't configured in this environment rather than faking it.
  @Post(':id/zatca/submit')
  @HttpCode(200)
  submitZatca(@Param('id') id: string, @CurrentUser() user: { userId: string }) {
    return this.orders.submitZatca(id, user.userId);
  }
}
