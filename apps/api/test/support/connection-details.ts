/**
 * The parts of a connection URI that must never reach a log line or a
 * response: the URI itself, the credentials, the host with and without its
 * port, and the database name.
 */
export function connectionFragments(databaseUrl: string): string[] {
  const url = new URL(databaseUrl);
  return [
    databaseUrl,
    decodeURIComponent(url.username),
    decodeURIComponent(url.password),
    url.hostname,
    url.host,
    decodeURIComponent(url.pathname.slice(1)),
  ];
}

/** Every string inside a value, at any depth, including object keys. */
export function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectStrings);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) => [
      key,
      ...collectStrings(entry),
    ]);
  }
  return [];
}
