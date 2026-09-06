import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { RedeemPointsDto } from './dto/redeem-points.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { CustomersService } from './customers.service';

// Registering/looking up a customer and redeeming their points are base
// register-time operations -- no extra permission beyond being logged in,
// same as creating/paying an order.
@Controller('customers')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Post()
  create(@Body() dto: CreateCustomerDto) {
    return this.customers.create(dto);
  }

  @Get()
  findAll(@Query('phone') phone?: string) {
    return this.customers.findAll(phone);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.customers.findOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCustomerDto) {
    return this.customers.update(id, dto);
  }

  @Get(':id/ledger')
  ledger(@Param('id') id: string) {
    return this.customers.ledger(id);
  }

  @Post(':id/redeem')
  @HttpCode(200)
  redeem(@Param('id') id: string, @Body() dto: RedeemPointsDto) {
    return this.customers.redeemPoints(id, dto.points);
  }
}
