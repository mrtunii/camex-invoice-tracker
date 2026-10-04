import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { type Env, EnvValidationError, loadRootEnvFile, parseEnv } from './config/env.js';

function loadEnvOrExit(): Env {
  loadRootEnvFile();
  try {
    return parseEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

async function bootstrap(): Promise<void> {
  const env = loadEnvOrExit();
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(env), {
    bufferLogs: true,
  });
  configureApp(app, env);
  await app.listen(env.PORT);
}

void bootstrap();
