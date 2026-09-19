import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody is required to verify the payment webhook's HMAC signature over
  // the exact bytes the gateway signed (a re-serialized body would not match).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });

  app.setGlobalPrefix('api');

  // Boundary validation (Invariant 11): every incoming body/param is
  // validated and stripped of unknown fields before it reaches handlers.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { exposeDefaultValues: true },
    }),
  );

  app.enableCors({ origin: true, credentials: true });

  // Let BullMQ close its Redis connections and finish in-flight jobs on
  // SIGTERM/SIGINT instead of dropping them mid-processing; orphaned rows are
  // additionally recovered by the processor's sweeper on the next boot.
  app.enableShutdownHooks();

  const configService = app.get(ConfigService);
  const port = configService.get<number>('port') ?? 4000;
  await app.listen(port);
  console.log(`Backend running on http://localhost:${port}/api`);
}

bootstrap();
