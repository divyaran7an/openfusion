/** A JSON error response in the shape Fusion's HTTP handlers return. */
export function jsonError(type: string, message: string, status: number) {
  return Response.json({ error: { type, message } }, { status });
}
