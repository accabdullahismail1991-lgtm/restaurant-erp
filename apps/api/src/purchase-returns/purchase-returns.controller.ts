import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CreatePurchaseReturnDto } from './dto/create-purchase-return.dto';
import { PurchaseReturnsService } from './purchase-returns.service';

@Controller('purchase-returns')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PurchaseReturnsController {
  constructor(private readonly purchaseReturns: PurchaseReturnsService) {}

  @Get()
  findAll(@CurrentUser() user: { userId: string }, @Query('locationId') locationId?: string) {
    return this.purchaseReturns.findAll(user.userId, locationId);
  }

  @Get('order/:purchaseOrderId/returnable-lines')
  returnableLines(@Param('purchaseOrderId') purchaseOrderId: string, @CurrentUser() user: { userId: string }) {
    return this.purchaseReturns.returnableLines(purchaseOrderId, user.userId);
  }

  @Post()
  @RequirePermission('purchasing.return_po')
  create(@Body() dto: CreatePurchaseReturnDto, @CurrentUser() user: { userId: string }) {
    return this.purchaseReturns.create(dto, user.userId);
  }
}
