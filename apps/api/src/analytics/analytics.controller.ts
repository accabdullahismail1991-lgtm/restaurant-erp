import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { AnalyticsService } from './analytics.service';
import { CostImpactSimulationDto } from './dto/cost-impact-simulation.dto';

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

  @Get('sales-trend')
  salesTrend(
    @CurrentUser() user: { userId: string },
    @Query('locationId') locationId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.salesTrend(user.userId, locationId, from, to);
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

  @Get('menu-engineering')
  menuEngineering(
    @CurrentUser() user: { userId: string },
    @Query('locationId') locationId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.menuEngineering(user.userId, locationId, from, to);
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

  @Get('purchase-returns-summary')
  purchaseReturnsSummary(
    @CurrentUser() user: { userId: string },
    @Query('locationId') locationId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.purchaseReturnsSummary(user.userId, locationId, from, to);
  }

  @Get('shifts-summary')
  shiftsSummary(
    @CurrentUser() user: { userId: string },
    @Query('locationId') locationId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.shiftsSummary(user.userId, locationId, from, to);
  }

  @Get('payment-methods-summary')
  paymentMethodsSummary(
    @CurrentUser() user: { userId: string },
    @Query('locationId') locationId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.paymentMethodsSummary(user.userId, locationId, from, to);
  }

  @Get('tax-summary')
  taxSummary(
    @CurrentUser() user: { userId: string },
    @Query('locationId') locationId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.taxSummary(user.userId, locationId, from, to);
  }

  @Get('production-summary')
  productionSummary(
    @CurrentUser() user: { userId: string },
    @Query('locationId') locationId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.productionSummary(user.userId, locationId, from, to);
  }

  @Get('peak-hours')
  peakHours(
    @CurrentUser() user: { userId: string },
    @Query('locationId') locationId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.peakHours(user.userId, locationId, from, to);
  }

  @Get('customer-experience')
  customerExperience(
    @CurrentUser() user: { userId: string },
    @Query('locationId') locationId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.customerExperience(user.userId, locationId, from, to);
  }

  @Get('kitchen-performance')
  kitchenPerformance(
    @CurrentUser() user: { userId: string },
    @Query('locationId') locationId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.kitchenPerformance(user.userId, locationId, from, to);
  }

  @Get('abc-analysis')
  abcAnalysis(
    @CurrentUser() user: { userId: string },
    @Query('locationId') locationId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.abcAnalysis(user.userId, locationId, from, to);
  }

  @Get('category-mix')
  categoryMix(
    @CurrentUser() user: { userId: string },
    @Query('locationId') locationId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.categoryMix(user.userId, locationId, from, to);
  }

  @Get('period-comparison')
  periodComparison(
    @CurrentUser() user: { userId: string },
    @Query('locationId') locationId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.periodComparison(user.userId, locationId, from, to);
  }

  @Get('net-sales')
  netSales(
    @CurrentUser() user: { userId: string },
    @Query('locationId') locationId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.netSales(user.userId, locationId, from, to);
  }

  @Get('daily-consumption')
  dailyConsumption(
    @CurrentUser() user: { userId: string },
    @Query('locationId') locationId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.dailyConsumption(user.userId, locationId, from, to);
  }

  // POST (not GET) because the hypothetical ingredient cost list is a real
  // request body, not a few scalar filters.
  @Post('cost-impact-simulation')
  costImpactSimulation(@CurrentUser() user: { userId: string }, @Body() dto: CostImpactSimulationDto) {
    return this.analytics.costImpactSimulation(user.userId, dto.ingredientChanges, dto.locationId, dto.from, dto.to);
  }
}
