import { IsOptional, IsString } from 'class-validator';

export class CreateSupplierDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  phone?: string;

  // null/omitted = available to every location (a central/strategic
  // supplier); set = only usable for that one location's POs (a local/
  // fresh-produce supplier). Item-level purchasing rules from
  // docs/DECISIONS.md #7 are a further refinement, not built yet.
  @IsOptional()
  @IsString()
  scopeLocationId?: string;
}
