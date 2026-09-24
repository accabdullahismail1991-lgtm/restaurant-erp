import { ArrayUnique, IsArray, IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateUserDto {
  @IsString()
  name!: string;

  @IsString()
  phone!: string;

  // Optional alternate login identifier -- lets this user log in with a
  // username instead of memorizing their phone number. Uniqueness (against
  // both other usernames AND other users' phone numbers) is enforced in
  // UsersService.create().
  @IsOptional()
  @IsString()
  @MinLength(3, { message: 'اسم المستخدم يجب أن يكون 3 أحرف على الأقل' })
  username?: string;

  // Not a login identifier, never used to send email (see User.email schema
  // comment) -- purely a note for an admin generating a password-reset link.
  @IsOptional()
  @IsEmail({}, { message: 'صيغة البريد الإلكتروني غير صحيحة' })
  email?: string;

  @IsString()
  @MinLength(8, { message: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' })
  password!: string;

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
