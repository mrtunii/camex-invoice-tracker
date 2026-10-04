import { Global, Module } from '@nestjs/common';
import type { Clock } from '@camex/shared';

/** Injection token for the {@link Clock}: "now" for business logic, movable in tests. */
export const CLOCK = Symbol('CLOCK');

@Global()
@Module({
  // One object per app, so a test can spy on its `now` without touching other apps.
  providers: [{ provide: CLOCK, useFactory: (): Clock => ({ now: () => new Date() }) }],
  exports: [CLOCK],
})
export class ClockModule {}
