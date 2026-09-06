import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ApprovalDecisionDto } from './dto/approval-decision.dto';
import { CreateStocktakeDto } from './dto/create-stocktake.dto';
import { SetStocktakeLinesDto } from './dto/stocktake-lines.dto';
import { StocktakesService } from './stocktakes.service';

// Stocktake is itself a form of inventory adjustment (docs/ARCHITECTURE.md
// roadmap, Phase 4) -- gated by the same inventory.adjust permission as
// manual receipts/waste. WHO specifically may approve a given stocktake's
// variance is a separate question the Approval Matrix answers per-request
// inside the service, same as Purchasing.
@Controller('stocktakes')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission('inventory.adjust')
export class StocktakesController {
  constructor(private readonly stocktakes: StocktakesService) {}

  @Post()
  create(@Body() dto: CreateStocktakeDto, @CurrentUser() user: { userId: string }) {
    return this.stocktakes.create(dto, user.userId);
  }

  @Get()
  findAll(
    @CurrentUser() user: { userId: string },
    @Query('locationId') locationId?: string,
    @Query('status') status?: string,
  ) {
    return this.stocktakes.findAll(user.userId, locationId, status);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: { userId: string }) {
    return this.stocktakes.findOne(id, user.userId);
  }

  @Put(':id/lines')
  setLines(@Param('id') id: string, @Body() dto: SetStocktakeLinesDto, @CurrentUser() user: { userId: string }) {
    return this.stocktakes.setLines(id, dto, user.userId);
  }

  @Post(':id/submit')
  @HttpCode(200)
  submit(@Param('id') id: string, @CurrentUser() user: { userId: string }) {
    return this.stocktakes.submit(id, user.userId);
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(@Param('id') id: string, @Body() dto: ApprovalDecisionDto, @CurrentUser() user: { userId: string }) {
    return this.stocktakes.approve(id, dto, user.userId);
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(@Param('id') id: string, @Body() dto: ApprovalDecisionDto, @CurrentUser() user: { userId: string }) {
    return this.stocktakes.reject(id, dto, user.userId);
  }
}
