import { IsIn, IsString, Matches } from 'class-validator';
import type { Channel } from './verification-delivery';

export class ChannelDto {
  @IsIn(['email', 'phone'])
  channel!: Channel;
}
export class VerifyCodeDto {
  @IsString()
  @Matches(/^[0-9]{6}$/)
  code!: string;
}
