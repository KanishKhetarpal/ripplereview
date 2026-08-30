import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { AppConfigService } from './app-config.service';
import { validateEnv } from './env.validation';
import { ENV_FILES, loadAndValidateEnv } from './load-env';

// Runs before the decorator below is evaluated. See load-env.ts for why this cannot be
// left to ConfigModule's own `validate` hook.
loadAndValidateEnv();

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ENV_FILES,
      // Kept so ConfigService serves the coerced values (numbers as numbers) rather than
      // the raw strings in process.env.
      validate: validateEnv,
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
