import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { AdvanceCategoryDto } from './dto/advance-category.dto';
import { KitchenService } from './kitchen.service';

// Viewing the queue and bumping a line are base kitchen-staff operations --
// no extra permission beyond being logged in, same as creating/paying an
// order (orders.controller.ts's own comment).
@Controller('kitchen')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class KitchenController {
  constructor(private readonly kitchen: KitchenService) {}

  @Get('queue')
  queue(@Query('locationId') locationId: string, @CurrentUser() user: { userId: string }) {
    return this.kitchen.queue(user.userId, locationId);
  }

  @Post('lines/:id/advance')
  @HttpCode(200)
  advance(@Param('id') id: string, @CurrentUser() user: { userId: string }) {
    return this.kitchen.advance(id, user.userId);
  }

  // Bulk "finish this category" button on the KDS screen -- see
  // KitchenService.advanceCategory()'s own comment.
  @Post('advance-category')
  @HttpCode(200)
  advanceCategory(@Body() dto: AdvanceCategoryDto, @CurrentUser() user: { userId: string }) {
    return this.kitchen.advanceCategory(user.userId, dto.locationId, dto.category);
  }

  @Post('orders/:orderId/acknowledge-cancel')
  @HttpCode(200)
  acknowledgeCancel(@Param('orderId') orderId: string, @CurrentUser() user: { userId: string }) {
    return this.kitchen.acknowledgeCancel(orderId, user.userId);
  }
}
