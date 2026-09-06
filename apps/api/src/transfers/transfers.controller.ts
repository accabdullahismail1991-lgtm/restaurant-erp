import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { TransferStatus } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CreateTransferDto } from './dto/create-transfer.dto';
import { ReceiveTransferDto } from './dto/receive-transfer.dto';
import { TransfersService } from './transfers.service';

@Controller('transfers')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @Post()
  @RequirePermission('transfers.manage')
  create(@Body() dto: CreateTransferDto, @CurrentUser() user: { userId: string }) {
    return this.transfers.create(dto, user.userId);
  }

  @Get()
  findAll(
    @CurrentUser() user: { userId: string },
    @Query('locationId') locationId?: string,
    @Query('status') status?: TransferStatus,
  ) {
    return this.transfers.findAll(user.userId, locationId, status);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: { userId: string }) {
    return this.transfers.findOne(id, user.userId);
  }

  @Post(':id/receive')
  @HttpCode(200)
  @RequirePermission('transfers.manage')
  receive(@Param('id') id: string, @Body() dto: ReceiveTransferDto, @CurrentUser() user: { userId: string }) {
    return this.transfers.receive(id, dto, user.userId);
  }
}
