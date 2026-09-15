import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CreateOrderTypeDto } from './dto/create-order-type.dto';
import { UpdateOrderTypeDto } from './dto/update-order-type.dto';
import { OrderTypesService } from './order-types.service';

@Controller('order-types')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class OrderTypesController {
  constructor(private readonly orderTypes: OrderTypesService) {}

  // Reading the list is a base cashier operation (the New Order picker
  // needs it) -- no extra permission beyond being logged in, same as
  // payment methods. Only creating/editing types is gated.
  @Get()
  findAll(@Query('activeOnly') activeOnly?: string) {
    return this.orderTypes.findAll(activeOnly === 'true');
  }

  @Post()
  @RequirePermission('order_types.manage')
  create(@Body() dto: CreateOrderTypeDto) {
    return this.orderTypes.create(dto);
  }

  @Patch(':id')
  @RequirePermission('order_types.manage')
  update(@Param('id') id: string, @Body() dto: UpdateOrderTypeDto) {
    return this.orderTypes.update(id, dto);
  }
}
