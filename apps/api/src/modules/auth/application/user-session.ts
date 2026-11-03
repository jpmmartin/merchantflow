/** A stored session. It holds the hash of the token secret, never the token. */
export interface UserSession {
  readonly id: string;
  readonly userId: string;
  /** Public identifier embedded in the token. */
  readonly lookupId: string;
  /** SHA-256 of the secret part of the token, in lowercase hexadecimal. */
  readonly secretHash: string;
  readonly createdAt: Date;
  /** The session does not authenticate at or after this time. */
  readonly expiresAt: Date;
  /** `null` while the session has not been signed out. */
  readonly revokedAt: Date | null;
}
