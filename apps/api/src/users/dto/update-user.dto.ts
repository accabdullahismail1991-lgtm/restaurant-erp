import { ArrayUnique, IsArray, IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  // Optional reset -- omit to leave the current password untouched. There is
  // deliberately no "confirm old password" step here: only a user holding
  // users.manage (an admin) can reach this endpoint at all, the same trust
  // level that already lets them assign roles/locations.
  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' })
  password?: string;

  // When provided, REPLACES the user's full set of roles/location scopes
  // (not a merge) -- simplest correct semantics for this first pass.
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  roleIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  locationIds?: string[];
}
