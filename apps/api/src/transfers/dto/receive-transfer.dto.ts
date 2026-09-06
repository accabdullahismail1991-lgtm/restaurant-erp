import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsNumber, IsString, Min, ValidateNested } from 'class-validator';

export class ReceivedLineInputDto {
  @IsString()
  ingredientId!: string;

  // May be less than what was sent (transit loss, docs/DECISIONS.md #6) --
  // never negative, and TransfersService rejects receiving more than was
  // sent (that's not a physically sensible outcome for a shipment).
  @IsNumber()
  @Min(0)
  quantityReceived!: number;
}

export class ReceiveTransferDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReceivedLineInputDto)
  lines!: ReceivedLineInputDto[];
}
