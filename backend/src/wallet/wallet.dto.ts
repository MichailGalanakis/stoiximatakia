import { Type } from 'class-transformer';
import {
  IsIn,
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
