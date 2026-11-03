/** Longest email address accepted, the column bound. */
export const EMAIL_MAX_LENGTH = 254;

/**
 * Lower-case ASCII address with one `@` and a dotted domain. It matches the
 * `users_email_check` constraint, so PostgreSQL is never the first to refuse
 * an address.
 */
const EMAIL_PATTERN =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * Returns the stored form of an email address, in lower case, or `undefined`
 * when the address cannot be stored. Login and user creation both use it, so
 * an address matches whatever its case.
 */
export function normalizeEmail(email: string): string | undefined {
  const normalized = email.toLowerCase();
  return normalized.length <= EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(normalized)
    ? normalized
    : undefined;
}
