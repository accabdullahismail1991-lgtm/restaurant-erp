import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CostAdjustmentDto, ReceiveInventoryDto, WasteInventoryDto } from './dto/adjust-inventory.dto';
import { InventoryService } from './inventory.service';

@Controller('inventory')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  // Reading balances (stock levels) is back-office info, unlike GET
  // /locations or /items -- a plain cashier doesn't need it to sell.
  @Get('balances')
  @RequirePermission('inventory.view')
  getBalances(@CurrentUser() user: { userId: string }, @Query('locationId') locationId?: string) {
    return this.inventory.getBalances(user.userId, locationId);
  }

  // Item card (Phase 1 report): one ingredient's full movement ledger at
  // one location, with a running balance -- see InventoryService.getItemCard.
  @Get('ingredients/:ingredientId/movements')
  @RequirePermission('inventory.view')
  getItemCard(
    @CurrentUser() user: { userId: string },
    @Param('ingredientId') ingredientId: string,
    @Query('locationId') locationId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.inventory.getItemCard(user.userId, ingredientId, locationId, from, to);
  }

  @Post('adjustments')
  @RequirePermission('inventory.adjust')
  receive(@Body() dto: ReceiveInventoryDto, @CurrentUser() user: { userId: string }) {
    return this.inventory.recordReceipt(dto, user.userId);
  }

  @Post('waste')
  @RequirePermission('inventory.adjust')
  waste(@Body() dto: WasteInventoryDto, @CurrentUser() user: { userId: string }) {
    return this.inventory.recordWaste(dto, user.userId);
  }

  @Post('cost-adjustments')
  @RequirePermission('inventory.adjust')
  adjustCost(@Body() dto: CostAdjustmentDto, @CurrentUser() user: { userId: string }) {
    return this.inventory.recordCostAdjustment(dto, user.userId);
  }

  @Post('settle-negative-stock')
  @HttpCode(200)
  @RequirePermission('inventory.adjust')
  settleNegativeStock(@CurrentUser() user: { userId: string }, @Query('locationId') locationId?: string) {
    return this.inventory.settleAllNegativeStock(user.userId, locationId);
  }
}
