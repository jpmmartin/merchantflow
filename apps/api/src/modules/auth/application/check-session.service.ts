import type { Database } from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../clock/clock.js';
import { DATABASE } from '../../database/database.module.js';
import { findUserSessionStateById } from '../infrastructure/user-session-queries.js';

export type SessionCheckResult =
  | { readonly active: true; readonly expiresAt: Date }
  | { readonly active: false };

/**
 * Tells whether a session that authenticated an earlier request still
 * authenticates now, by the same rules as `AuthenticateSessionService`: not
 * revoked, not expired, and its user enabled. It is for long-lived responses,
 * such as an event stream, that must end when their credential does. The
 * session and its user are read on every call and never cached.
 */
@Injectable()
export class CheckSessionService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: {
    readonly sessionId: string;
    readonly userId: string;
  }): Promise<SessionCheckResult> {
    const state = await findUserSessionStateById(
      this.database,
      command.sessionId,
    );
    if (
      state === undefined ||
      state.userId !== command.userId ||
      state.revokedAt !== null ||
      !state.userEnabled ||
      state.expiresAt.getTime() <= this.clock.now().getTime()
    ) {
      return { active: false };
    }
    return { active: true, expiresAt: state.expiresAt };
  }
}
