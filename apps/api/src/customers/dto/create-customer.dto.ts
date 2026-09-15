import { IsOptional, IsString } from 'class-validator';

export class CreateCustomerDto {
  @IsString()
  phone!: string;

  @IsOptional()
  @IsString()
  name?: string;

  // Links this customer to a price list (SalesChannel) -- e.g. a delivery
  // app account, a wholesale/company customer -- applied automatically by
  // OrdersService.create() once this customer is selected on an order.
  @IsOptional()
  @IsString()
  defaultSalesChannelId?: string;
}
