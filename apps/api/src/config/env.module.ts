import { type DynamicModule, Global, Module } from '@nestjs/common';
import type { Env } from './env.js';

/** Injection token for the validated {@link Env}. */
export const ENV = Symbol('ENV');

@Global()
@Module({})
export class EnvModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: EnvModule,
      providers: [{ provide: ENV, useValue: env }],
      exports: [ENV],
    };
  }
}
