import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ReceiveInventoryDto, WasteInventoryDto } from './dto/adjust-inventory.dto';
import { InventoryService } from './inventory.service';

@Controller('inventory')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  // Reading balances only requires being logged in -- same pattern as
  // GET /locations. Writing (adjustments/waste) requires inventory.adjust.
  @Get('balances')
  getBalances(@CurrentUser() user: { userId: string }, @Query('locationId') locationId?: string) {
    return this.inventory.getBalances(user.userId, locationId);
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
}
