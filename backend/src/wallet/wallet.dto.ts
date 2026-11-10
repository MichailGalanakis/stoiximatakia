import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  ValidateNested,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  NotEquals,
} from 'class-validator';

export class AmountOperationDto {
  @IsUUID() operationId!: string;
  @IsInt() @Min(1) @Max(100_000_000) amountMinor!: number;
}
export class DepositDto extends AmountOperationDto {
  @IsOptional() @Matches(/^[a-z0-9_]{2,40}$/) method?: string;
}
const COUNTRY = /^[A-Z]{2}$/;
export class CountryDto {
  @Matches(COUNTRY) country!: string;
}
export class JurisdictionDto {
  @IsBoolean() approved!: boolean;
  @IsString() @Length(0, 500) note!: string;
}
export class UserIdDto {
  @IsUUID() userId!: string;
}
export class PaymentMethodDto {
  @Matches(/^[a-z0-9_]{2,40}$/) method!: string;
  @Matches(/^[a-z0-9_]{2,40}$/) provider!: string;
  @Matches(COUNTRY) country!: string;
  @IsIn(['deposit', 'withdrawal']) direction!: 'deposit' | 'withdrawal';
  @IsBoolean() active!: boolean;
}
export class BankReceiptDto {
  @IsString() @Length(1, 100) bankReference!: string;
  @Matches(/^RF[0-9]{2}[A-Z0-9]{1,21}$/) rfCode!: string;
  @IsInt() @Min(1) @Max(100_000_000) amountMinor!: number;
  @IsISO8601({ strict: true }) paidAt!: string;
}
export class BankReceiptsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => BankReceiptDto)
  lines!: BankReceiptDto[];
}
export class ConfirmPayoutDto {
  @IsIn(['paid', 'failed']) outcome!: 'paid' | 'failed';
  @IsString() @Length(1, 100) bankReference!: string;
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
/** The reviewer is the authenticated admin, never a client-supplied name. */
export class ReviewDto {
  @IsOptional() @IsString() @Length(1, 500) note?: string;
}
export class AdminNameDto {
  @Matches(/^[a-z0-9._-]{2,40}$/) name!: string;
}
export class CreateAdminDto extends AdminNameDto {
  @IsIn(['viewer', 'finance', 'admin']) role!: 'viewer' | 'finance' | 'admin';
}
export class CorrectionDto {
  @IsUUID() id!: string;
  @IsUUID() userId!: string;
  @IsInt()
  @Min(-100_000_000)
  @Max(100_000_000)
  @NotEquals(0)
  amountMinor!: number;
  @IsString() @Length(5, 500) reason!: string;
}
export class CorrectionIdDto {
  @IsUUID() correctionId!: string;
}
export class DecisionDto {
  @IsIn(['approve', 'reject']) decision!: 'approve' | 'reject';
}
export class OpenDisputeDto {
  @IsUUID() depositId!: string;
  @IsString() @Length(1, 500) reason!: string;
}
export class DisputeIdDto {
  @IsUUID() disputeId!: string;
}
export class ResolveDisputeDto extends ReviewDto {
  @IsIn(['won', 'lost']) outcome!: 'won' | 'lost';
}
export class ReconcileDto {
  @IsString() @Length(1, 40) provider!: string;
  @IsISO8601({ strict: true }) periodEnd!: string;
  @IsInt()
  @Min(-100_000_000_000)
  @Max(100_000_000_000)
  reportedHeldMinor!: number;
}
export class StatusFilterDto {
  @IsOptional() @IsString() @Length(1, 20) status?: string;
}
export class AuditQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
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
