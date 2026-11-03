const FOREIGN_KEY_VIOLATION = '23503';

/**
 * Tells whether an error is PostgreSQL's foreign key violation for the named
 * constraint. Any other error, including a violation of another constraint, is
 * not matched, so the caller still sees it.
 */
export function isForeignKeyViolation(
  error: unknown,
  constraint: string,
): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === FOREIGN_KEY_VIOLATION &&
    'constraint' in error &&
    error.constraint === constraint
  );
}

const UNIQUE_VIOLATION = '23505';

/**
 * Tells whether an error is PostgreSQL's unique violation for the named
 * constraint. Any other error is not matched, so the caller still sees it.
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === UNIQUE_VIOLATION &&
    'constraint' in error &&
    error.constraint === constraint
  );
}
