import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DomainErrorFilter } from './common/domain-error.filter';
import { AppConfigService } from './config/app-config.service';
import { ReviewWorkerService } from './github/review-worker.service';

async function bootstrap(): Promise<void> {
  // rawBody keeps the exact bytes Express received. GitHub signs what it sent, so a
  // re-serialised body would fail every signature check.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new DomainErrorFilter());
  // No global pipe: bodies are validated per-route with ZodValidationPipe. Nest's
  // ValidationPipe would pull in class-validator purely to re-describe schemas zod
  // already owns — and it fails at boot when that package is absent.

  const config = app.get(AppConfigService);

  // Started here rather than from a lifecycle hook, so a `ripplereview review` on a
  // laptop never quietly begins draining a shared queue.
  await app.get(ReviewWorkerService).start();

  // Without this, onApplicationShutdown never fires and the poll timer keeps the process
  // alive after a SIGTERM — which reads as a hung container.
  app.enableShutdownHooks();

  await app.listen(config.port);

  Logger.log(`RippleReview API listening on http://localhost:${config.port}/api/v1`, 'Bootstrap');
}

void bootstrap();
