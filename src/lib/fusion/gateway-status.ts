/**
 * Map a Vercel AI Gateway probe failure to a short, human reason for the studio. Kept as a
 * pure, dependency-free helper so the connectivity status is easy to test in
 * isolation. Quota is checked before auth so a "spend limit" message classifies as
 * a credit issue rather than a generic rejection.
 */
export function gatewayProbeReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/quota|credit|spend|limit exceeded|insufficient/i.test(message)) {
    return "The key reached its credit or spend limit.";
  }
  if (/unauthor|forbidden|invalid.*key|api key|\b401\b|\b403\b/i.test(message)) {
    return "The key was rejected (invalid or unauthorized).";
  }
  if (/timed out|timeout/i.test(message)) {
    return "Vercel AI Gateway didn't respond in time.";
  }
  return message.slice(0, 140);
}
