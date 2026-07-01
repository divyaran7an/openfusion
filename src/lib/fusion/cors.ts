/**
 * CORS for the OpenAI-compatible surface.
 *
 * Fusion is meant to be a drop-in baseURL for any client, including ones that run
 * in the browser (the chat example, web playgrounds, browser extensions). Local
 * OpenAI-compatible servers conventionally allow cross-origin requests so those
 * clients can reach them; we follow suit. CORS does not weaken auth — a bearer key
 * is still required whenever `FUSION_API_KEYS` is set.
 */
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, x-fusion-api-key",
  "Access-Control-Max-Age": "86400"
};

/** Return a copy of a response with CORS headers added (preserves a streaming body). */
export function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

/** Answer a CORS preflight (OPTIONS) request. */
export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
