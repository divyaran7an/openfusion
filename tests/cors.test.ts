import assert from "node:assert/strict";
import test from "node:test";

import { corsPreflight, withCors } from "../src/lib/fusion/cors.ts";

test("corsPreflight answers with 204 and permissive CORS headers", () => {
  const response = corsPreflight();
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.match(response.headers.get("access-control-allow-methods") ?? "", /POST/);
  assert.match(response.headers.get("access-control-allow-headers") ?? "", /Authorization/);
});

test("withCors adds CORS headers while preserving status, body, and existing headers", async () => {
  const original = new Response("hello", {
    status: 201,
    headers: { "content-type": "text/plain" }
  });
  const wrapped = withCors(original);
  assert.equal(wrapped.status, 201);
  assert.equal(wrapped.headers.get("access-control-allow-origin"), "*");
  // Existing headers survive, and the body is carried through unchanged.
  assert.equal(wrapped.headers.get("content-type"), "text/plain");
  assert.equal(await wrapped.text(), "hello");
});
