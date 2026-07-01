import assert from "node:assert/strict";
import test from "node:test";

import {
  createWebFetchTool,
  extractCitationMetadata,
  hasWebFetchTool,
  webFetch
} from "../src/lib/fusion/web-tools.ts";

type WebFetchExecute = (
  input: {
    url: string;
    allowedDomains?: string[];
  },
  options: { toolCallId: string; messages: [] }
) => Promise<{ ok: boolean; error?: string }>;

test("webFetch citation metadata extracts canonical source fields", () => {
  const metadata = extractCitationMetadata(
    `
      <html>
        <head>
          <title>Fallback title</title>
          <link href="/canonical?ref=card#ignored" rel="canonical">
          <meta property="og:title" content="Primary &amp; Title">
          <meta name="description" content="Short evidence summary.">
          <meta property="og:site_name" content="Example Research">
          <meta property="article:published_time" content="2026-06-20T10:00:00Z">
        </head>
      </html>
    `,
    "https://example.com/articles/fusion",
    "2026-06-23T00:00:00.000Z"
  );

  assert.deepEqual(metadata, {
    title: "Primary & Title",
    description: "Short evidence summary.",
    canonical_url: "https://example.com/canonical?ref=card",
    site_name: "Example Research",
    published_at: "2026-06-20T10:00:00Z",
    fetched_at: "2026-06-23T00:00:00.000Z"
  });
});

test("webFetch can be disabled by environment", () => {
  const original = process.env.FUSION_WEB_FETCH;
  process.env.FUSION_WEB_FETCH = "0";
  assert.equal(hasWebFetchTool(), false);

  if (original === undefined) {
    delete process.env.FUSION_WEB_FETCH;
  } else {
    process.env.FUSION_WEB_FETCH = original;
  }
});

test("webFetch blocks local and private-network targets before fetching", async () => {
  const execute = webFetch.execute as unknown as WebFetchExecute;
  const result = await execute(
    { url: "http://127.0.0.1:3001/api/health" },
    { toolCallId: "test-local-block", messages: [] }
  );

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Private IPv4 addresses are not allowed/);
});

test("webFetch enforces caller domain allowlists", async () => {
  const execute = webFetch.execute as unknown as WebFetchExecute;
  const result = await execute(
    {
      url: "https://example.com",
      allowedDomains: ["openai.com"]
    },
    { toolCallId: "test-allowlist", messages: [] }
  );

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Domain is not in the allowlist/);
});

test("webFetch enforces per-request max_uses configuration", async () => {
  const configured = createWebFetchTool({ max_uses: 1 });
  const execute = configured.execute as unknown as WebFetchExecute;

  await execute(
    { url: "http://127.0.0.1:3001/api/health" },
    { toolCallId: "test-max-uses-first", messages: [] }
  );
  const result = await execute(
    { url: "https://example.com" },
    { toolCallId: "test-max-uses-second", messages: [] }
  );

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /max_uses limit reached/);
});
