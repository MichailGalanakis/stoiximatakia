import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { HealthReadiness } from './health/health-readiness';
import {
  REGISTRATION_SETTINGS,
  type RegistrationSettings,
} from './registration/registration-settings';
import { RegistrationModule } from './registration/registration.module';
import { HouseModule } from './house/house.module';
import { PlatformModule } from './tables/platform.module';
import { WalletModule } from './wallet/wallet.module';

@Module({
  imports: [RegistrationModule, PlatformModule, WalletModule, HouseModule],
  controllers: [HealthController],
  providers: [
    {
      provide: HealthReadiness,
      inject: [REGISTRATION_SETTINGS],
      useFactory: (settings: RegistrationSettings) =>
        new HealthReadiness(settings),
    },
  ],
})
export class AppModule {}
