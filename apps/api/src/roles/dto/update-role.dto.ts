import { ArrayUnique, IsArray, IsOptional, IsString } from 'class-validator';

export class UpdateRoleDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  // When provided, REPLACES the role's full permission set (not a merge) --
  // same semantics UsersService.update() already uses for roleIds/locationIds.
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permissionCodes?: string[];
}
