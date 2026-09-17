import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CreateReturnDto } from './dto/create-return.dto';
import { VoidPaidOrderDto } from './dto/void-paid-order.dto';
import { ReturnsService } from './returns.service';

@Controller('returns')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  @Get()
  findAll(@CurrentUser() user: { userId: string }, @Query('locationId') locationId?: string) {
    return this.returns.findAll(user.userId, locationId);
  }

  @Get('order/:orderId/returnable-lines')
  returnableLines(@Param('orderId') orderId: string, @CurrentUser() user: { userId: string }) {
    return this.returns.returnableLines(orderId, user.userId);
  }

  // Full detail for one return (credit-note popup) -- separate from the
  // findAll() list above, same "list is summary, :id is full detail"
  // pattern OrdersController already uses.
  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: { userId: string }) {
    return this.returns.findOne(id, user.userId);
  }

  @Post()
  @RequirePermission('pos.return_order')
  create(@Body() dto: CreateReturnDto, @CurrentUser() user: { userId: string }) {
    return this.returns.create(dto, user.userId);
  }

  // A stricter, manager-only permission than pos.return_order -- see
  // ReturnsService.voidPaidOrder for why this is a separate action from a
  // regular line-level return rather than just "return every line".
  @Post('void-paid-order/:orderId')
  @HttpCode(200)
  @RequirePermission('pos.void_paid_order')
  voidPaidOrder(@Param('orderId') orderId: string, @Body() dto: VoidPaidOrderDto, @CurrentUser() user: { userId: string }) {
    return this.returns.voidPaidOrder(orderId, user.userId, dto.reason);
  }
}
