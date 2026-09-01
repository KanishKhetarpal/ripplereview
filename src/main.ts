import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DomainErrorFilter } from './common/domain-error.filter';
import { AppConfigService } from './config/app-config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new DomainErrorFilter());
  // No global pipe: bodies are validated per-route with ZodValidationPipe. Nest's
  // ValidationPipe would pull in class-validator purely to re-describe schemas zod
  // already owns — and it fails at boot when that package is absent.

  const config = app.get(AppConfigService);
  await app.listen(config.port);

  Logger.log(`RippleReview API listening on http://localhost:${config.port}/api/v1`, 'Bootstrap');
}

void bootstrap();
