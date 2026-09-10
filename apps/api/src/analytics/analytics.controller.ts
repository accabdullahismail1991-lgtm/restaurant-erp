import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { AnalyticsService } from './analytics.service';

// Unlike base POS operations (create/pay an order), reading revenue/margin
// numbers is commercially sensitive -- every route here is gated behind
// analytics.view rather than "just logged in".
@Controller('analytics')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission('analytics.view')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('sales-summary')
  salesSummary(
    @CurrentUser() user: { userId: string },
    @Query('locationId') locationId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.salesSummary(user.userId, locationId, from, to);
  }

  @Get('top-items')
  topItems(
    @CurrentUser() user: { userId: string },
    @Query('locationId') locationId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.analytics.topItems(user.userId, locationId, from, to, limit ? parseInt(limit, 10) : undefined);
  }

  @Get('food-cost')
  foodCost(
    @CurrentUser() user: { userId: string },
    @Query('locationId') locationId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.foodCost(user.userId, locationId, from, to);
  }

  @Get('inventory-valuation')
  inventoryValuation(@CurrentUser() user: { userId: string }, @Query('locationId') locationId?: string) {
    return this.analytics.inventoryValuation(user.userId, locationId);
  }

  @Get('low-stock')
  lowStock(@CurrentUser() user: { userId: string }, @Query('locationId') locationId?: string) {
    return this.analytics.lowStock(user.userId, locationId);
  }

  @Get('menu-item-costs')
  menuItemCosts(@CurrentUser() user: { userId: string }, @Query('locationId') locationId?: string) {
    return this.analytics.menuItemCosts(user.userId, locationId);
  }

  @Get('purchasing-summary')
  purchasingSummary(
    @CurrentUser() user: { userId: string },
    @Query('locationId') locationId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.purchasingSummary(user.userId, locationId, from, to);
  }

  @Get('returns-summary')
  returnsSummary(
    @CurrentUser() user: { userId: string },
    @Query('locationId') locationId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.returnsSummary(user.userId, locationId, from, to);
  }
}
