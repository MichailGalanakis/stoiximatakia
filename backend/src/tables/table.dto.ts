import {
  IsIn,
  IsInt,
  IsOptional,
  IsObject,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { CONTRIBUTIONS_MINOR, GAME_IDS } from './game-catalog';
import type { GameId } from './game-catalog';

export class OperationDto {
  @IsUUID() operationId!: string;
}
export class GameOperationDto extends OperationDto {
  @IsInt() @Min(1) @Max(2_147_483_646) expectedRevision!: number;
}
export class GameActionDto extends GameOperationDto {
  @IsObject() action!: Record<string, unknown>;
}
export class GameSelectionDto {
  @IsInt() @Min(1) @Max(2_147_483_646) expectedRevision!: number;
  @IsObject() selection!: Record<string, unknown>;
}
export class CreateTableDto extends OperationDto {
  @IsIn(GAME_IDS) gameId!: GameId;
  @IsString() @Length(1, 48) name!: string;
  @IsIn(['public', 'private']) visibility!: 'public' | 'private';
  @IsString() @Length(1, 16) formatId!: string;
  @IsIn(CONTRIBUTIONS_MINOR) prizeContributionMinor!: number;
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9]{6,32}$/) accessCode?: string;
}
export class SeatDto extends OperationDto {
  @IsInt() @Min(0) @Max(3) seatIndex!: number;
}
export class PrivateAccessDto {
  @IsString() @Matches(/^[A-Za-z0-9]{6,32}$/) code!: string;
}
export class ListTablesDto {
  @IsIn(GAME_IDS) gameId!: GameId;
}
export class TableIdDto {
  @IsUUID() tableId!: string;
}
