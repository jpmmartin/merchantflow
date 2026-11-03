/** A timestamp from the API in the browser's locale, or a dash for none. */
export function formatTime(iso: string | null): string {
  return iso === null ? '—' : new Date(iso).toLocaleString();
}
