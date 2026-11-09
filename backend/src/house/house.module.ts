import { Module } from '@nestjs/common';
import { RegistrationModule } from '../registration/registration.module';
import { PlatformModule } from '../tables/platform.module';
import { HouseGameController } from './house-game.controller';
import { HouseGameStore } from './house-game.store';

@Module({
  imports: [RegistrationModule, PlatformModule],
  controllers: [HouseGameController],
  providers: [HouseGameStore],
})
export class HouseModule {}
