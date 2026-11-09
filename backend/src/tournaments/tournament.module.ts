import { Module } from '@nestjs/common';
import { RegistrationModule } from '../registration/registration.module';
import { WalletModule } from '../wallet/wallet.module';
import {
  TournamentAdminController,
  TournamentController,
} from './tournament.controller';
import { TournamentStore } from './tournament.store';

@Module({
  imports: [RegistrationModule, WalletModule],
  controllers: [TournamentController, TournamentAdminController],
  providers: [TournamentStore],
  exports: [TournamentStore],
})
export class TournamentModule {}
