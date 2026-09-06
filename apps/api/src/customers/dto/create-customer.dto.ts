import { IsOptional, IsString } from 'class-validator';

export class CreateCustomerDto {
  @IsString()
  phone!: string;

  @IsOptional()
  @IsString()
  name?: string;
}
