import { Controller, Get, Param } from '@nestjs/common';
import { OrdersService } from './orders.service';

// Deliberately unguarded -- this is the endpoint the customer-facing order
// tracking page (a public link/QR the staff hand the customer, not a
// login-gated screen) polls. See OrdersService.publicStatus() for exactly
// what it exposes and why the order's own id is safe to use as the token.
@Controller('public/orders')
export class PublicOrderStatusController {
  constructor(private readonly orders: OrdersService) {}

  @Get(':id/status')
  status(@Param('id') id: string) {
    return this.orders.publicStatus(id);
  }
}
