/** Source of the current time. Business logic reads time only through it. */
export interface Clock {
  now(): Date;
}

/** Injection token of the `Clock` that every module shares. */
export const CLOCK = Symbol('CLOCK');
