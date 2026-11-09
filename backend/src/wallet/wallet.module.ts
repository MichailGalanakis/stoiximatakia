import { Module } from '@nestjs/common';
import { RegistrationModule } from '../registration/registration.module';
import { WalletAdminController, WalletController } from './wallet.controller';
import { WALLET_SETTINGS, walletSettings } from './wallet-settings';
import { WalletStore } from './wallet.store';

@Module({
  imports: [RegistrationModule],
  controllers: [WalletController, WalletAdminController],
  providers: [
    WalletStore,
    { provide: WALLET_SETTINGS, useFactory: () => walletSettings() },
  ],
  exports: [WalletStore],
})
export class WalletModule {}
