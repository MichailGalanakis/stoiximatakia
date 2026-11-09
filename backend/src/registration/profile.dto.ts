import { IsString, MaxLength } from 'class-validator';

// Saved profile metadata does not replace contact verification or establish KYC.
export class ProfileDetailsDto {
  @IsString()
  @MaxLength(80)
  fullName!: string;

  @IsString()
  @MaxLength(60)
  country!: string;

  @IsString()
  @MaxLength(80)
  city!: string;
}
