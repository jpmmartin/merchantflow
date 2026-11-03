import { Module } from '@nestjs/common';
import { CLOCK, type Clock } from './clock.js';

/** The clock of the running application, backed by the system time. */
const systemClock: Clock = { now: () => new Date() };

/** Provides the `Clock`. Tests override `CLOCK` to control time. */
@Module({
  providers: [{ provide: CLOCK, useValue: systemClock }],
  exports: [CLOCK],
})
export class ClockModule {}
