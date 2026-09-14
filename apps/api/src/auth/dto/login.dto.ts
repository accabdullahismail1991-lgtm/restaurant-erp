import { IsString, MinLength } from 'class-validator';

export class LoginDto {
  // Despite the field name (kept for wire compatibility with every
  // existing client), AuthService.login() accepts EITHER the user's phone
  // number OR their optional username here -- see User.username.
  @IsString()
  phone!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}
