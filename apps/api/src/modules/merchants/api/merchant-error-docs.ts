/** OpenAPI descriptions of the error responses the merchant routes share. */
export const UNAUTHENTICATED_DOC = {
  status: 401,
  description:
    'UNAUTHENTICATED: the API key or session token is missing, malformed, unknown, wrong, revoked, or expired, or the user is disabled.',
} as const;

export const INSUFFICIENT_ROLE_DOC = {
  status: 403,
  description:
    'INSUFFICIENT_ROLE: the role of the key does not allow the operation or a field of the request. Nothing was changed.',
} as const;

export const NOT_FOUND_DOC = {
  status: 404,
  description:
    'NOT_FOUND: the resource does not exist or belongs to another merchant. The two cannot be told apart, and a merchant key gets this before any role check.',
} as const;

export const VALIDATION_FAILED_DOC = {
  status: 400,
  description:
    'VALIDATION_FAILED or MALFORMED_JSON: the request does not match the schema, names an unknown field, or breaks a rule listed in issues.',
} as const;
