import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CreateSalesChannelDto } from './dto/create-sales-channel.dto';
import { UpdateSalesChannelDto } from './dto/update-sales-channel.dto';
import { SalesChannelsService } from './sales-channels.service';

@Controller('sales-channels')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SalesChannelsController {
  constructor(private readonly channels: SalesChannelsService) {}

  @Get()
  findAll() {
    return this.channels.findAll();
  }

  @Post()
  @RequirePermission('items.manage')
  create(@Body() dto: CreateSalesChannelDto) {
    return this.channels.create(dto);
  }

  @Patch(':id')
  @RequirePermission('items.manage')
  update(@Param('id') id: string, @Body() dto: UpdateSalesChannelDto) {
    return this.channels.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('items.manage')
  remove(@Param('id') id: string) {
    return this.channels.remove(id);
  }

  // Not gated behind items.manage -- like item prices themselves (GET
  // /items), reading the effective per-channel price list is display
  // data any authenticated user needs (e.g. the cashier picking a channel
  // in the Sales popup), not a management action.
  @Get(':id/item-prices')
  itemPrices(@Param('id') id: string) {
    return this.channels.itemPrices(id);
  }
}
