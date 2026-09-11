import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CreatePaymentMethodDto } from './dto/create-payment-method.dto';
import { UpdatePaymentMethodDto } from './dto/update-payment-method.dto';
import { PaymentMethodsService } from './payment-methods.service';

@Controller('payment-methods')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PaymentMethodsController {
  constructor(private readonly paymentMethods: PaymentMethodsService) {}

  // Reading the list is a base cashier operation (the pay/new-order forms
  // need it) -- no extra permission beyond being logged in, same as
  // customers/items. Only creating/editing methods is gated.
  @Get()
  findAll(@Query('activeOnly') activeOnly?: string) {
    return this.paymentMethods.findAll(activeOnly === 'true');
  }

  @Post()
  @RequirePermission('payment_methods.manage')
  create(@Body() dto: CreatePaymentMethodDto) {
    return this.paymentMethods.create(dto);
  }

  @Patch(':id')
  @RequirePermission('payment_methods.manage')
  update(@Param('id') id: string, @Body() dto: UpdatePaymentMethodDto) {
    return this.paymentMethods.update(id, dto);
  }
}
