/** A short, prefixed identifier: `${prefix}_<24 hex chars>` from a UUID. */
export function shortId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}
