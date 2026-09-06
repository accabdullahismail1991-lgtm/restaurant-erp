import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { POStatus } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ApprovalDecisionDto } from './dto/approval-decision.dto';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';
import { PurchaseOrdersService } from './purchase-orders.service';

@Controller('purchase-orders')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PurchaseOrdersController {
  constructor(private readonly purchaseOrders: PurchaseOrdersService) {}

  @Post()
  @RequirePermission('purchasing.create_po')
  create(@Body() dto: CreatePurchaseOrderDto, @CurrentUser() user: { userId: string }) {
    return this.purchaseOrders.create(dto, user.userId);
  }

  @Get()
  findAll(
    @CurrentUser() user: { userId: string },
    @Query('locationId') locationId?: string,
    @Query('status') status?: POStatus,
  ) {
    return this.purchaseOrders.findAll(user.userId, locationId, status);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: { userId: string }) {
    return this.purchaseOrders.findOne(id, user.userId);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @RequirePermission('purchasing.create_po')
  submit(@Param('id') id: string, @CurrentUser() user: { userId: string }) {
    return this.purchaseOrders.submit(id, user.userId);
  }

  // Deliberately NOT hardcoded to a single permission check the way other
  // write endpoints are -- purchasing.approve_po is a coarse baseline
  // (you're a kind of approver at all), but WHICH role can actually sign
  // off THIS PO is re-derived from the Approval Matrix (ApprovalRule
  // table) inside the service, per docs/DECISIONS.md #8.
  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('purchasing.approve_po')
  approve(@Param('id') id: string, @Body() dto: ApprovalDecisionDto, @CurrentUser() user: { userId: string }) {
    return this.purchaseOrders.approve(id, dto, user.userId);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermission('purchasing.approve_po')
  reject(@Param('id') id: string, @Body() dto: ApprovalDecisionDto, @CurrentUser() user: { userId: string }) {
    return this.purchaseOrders.reject(id, dto, user.userId);
  }

  @Post(':id/send')
  @HttpCode(200)
  @RequirePermission('purchasing.create_po')
  send(@Param('id') id: string, @CurrentUser() user: { userId: string }) {
    return this.purchaseOrders.send(id, user.userId);
  }

  @Post(':id/receive')
  @HttpCode(200)
  @RequirePermission('purchasing.create_po')
  receive(@Param('id') id: string, @CurrentUser() user: { userId: string }) {
    return this.purchaseOrders.receive(id, user.userId);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('purchasing.create_po')
  cancel(@Param('id') id: string, @CurrentUser() user: { userId: string }) {
    return this.purchaseOrders.cancel(id, user.userId);
  }
}
