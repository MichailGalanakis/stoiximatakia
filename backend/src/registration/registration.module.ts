import { VerificationService } from './verification.service';
import {
  VERIFICATION_CONFIG,
  VERIFICATION_DELIVERY,
  verificationConfig,
  HttpVerificationDelivery,
} from './verification-delivery';
import { Module } from '@nestjs/common';
import { RegistrationController } from './registration.controller';
import { RegistrationService } from './registration.service';
import { RegistrationStore } from './registration.store';
import {
  REGISTRATION_SETTINGS,
  registrationSettings,
} from './registration-settings';

@Module({
  controllers: [RegistrationController],
  exports: [RegistrationService, REGISTRATION_SETTINGS],
  providers: [
    RegistrationService,
    RegistrationStore,
    VerificationService,
    { provide: VERIFICATION_CONFIG, useFactory: () => verificationConfig() },
    { provide: VERIFICATION_DELIVERY, useClass: HttpVerificationDelivery },
    {
      provide: REGISTRATION_SETTINGS,
      useFactory: () => registrationSettings(),
    },
  ],
})
export class RegistrationModule {}
