import {
  Equals,
  IsBoolean,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterDto {
  @IsString()
  @MinLength(3)
  @MaxLength(30)
  username!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(72)
  password!: string;

  @IsString()
  @MaxLength(120)
  email!: string;

  @IsString()
  @MaxLength(30)
  phone!: string;

  @IsBoolean()
  @Equals(true)
  termsAccepted!: boolean;

  @IsString()
  @MaxLength(40)
  termsVersion!: string;
}
