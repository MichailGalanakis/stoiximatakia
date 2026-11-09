import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';

export class AmountOperationDto {
  @IsUUID() operationId!: string;
  @IsInt() @Min(1) @Max(100_000_000) amountMinor!: number;
}
export class WalletOperationDto {
  @IsUUID() operationId!: string;
}
export class WithdrawalIdDto {
  @IsUUID() withdrawalId!: string;
}
export class ProviderDto {
  @IsString() @Length(1, 40) provider!: string;
}
export class ReviewDto {
  @IsString() @Length(1, 80) reviewer!: string;
  @IsOptional() @IsString() @Length(1, 500) note?: string;
}
export class CapitalDto extends ReviewDto {
  @IsUUID() operationId!: string;
  @IsIn(['in', 'out']) direction!: 'in' | 'out';
  @IsInt() @Min(1) @Max(100_000_000) amountMinor!: number;
}
export class HouseMatchFilterDto {
  @IsOptional()
  @IsIn(['active', 'won', 'lost', 'void'])
  status?: string;
}
export class WithdrawalFilterDto {
  @IsOptional()
  @IsIn(['requested', 'processing', 'paid', 'rejected', 'cancelled', 'failed'])
  status?: string;
}
