import { Module } from '@nestjs/common';
import { RegistrationModule } from '../registration/registration.module';
import {
  REGISTRATION_SETTINGS,
  type RegistrationSettings,
} from '../registration/registration-settings';
import { GameRuntimeRegistry } from './game-runtime';
import {
  XeriGameRuntime,
  DilotiGameRuntime,
  KoumkanGameRuntime,
  ThanasisGameRuntime,
  BiribaGameRuntime,
  TichuGameRuntime,
} from './card-game-runtime';
import { PlatformController } from './platform.controller';
import { PlatformLive } from './platform-live';
import { PLATFORM_SETTINGS, platformSettings } from './platform-settings';
import { PlatformStore } from './platform.store';
import { ArtifactChessGameRuntime } from './artifact-chess-game-runtime';

@Module({
  imports: [RegistrationModule],
  controllers: [PlatformController],
  providers: [
    PlatformStore,
    PlatformLive,
    {
      provide: GameRuntimeRegistry,
      inject: [REGISTRATION_SETTINGS],
      useFactory: (settings: RegistrationSettings) => {
        const registry = new GameRuntimeRegistry();
        registry.register('xeri', new XeriGameRuntime());
        registry.register('diloti', new DilotiGameRuntime());
        registry.register('koumkan', new KoumkanGameRuntime());
        registry.register('thanasis', new ThanasisGameRuntime());
        registry.register('biriba', new BiribaGameRuntime());
        registry.register('tichu', new TichuGameRuntime());
        if (settings.databaseUrl)
          registry.register(
            'chess',
            new ArtifactChessGameRuntime({
              connectionString: settings.databaseUrl,
            }),
          );
        return registry;
      },
    },
    { provide: PLATFORM_SETTINGS, useFactory: platformSettings },
  ],
  exports: [PlatformStore, GameRuntimeRegistry],
})
export class PlatformModule {}
