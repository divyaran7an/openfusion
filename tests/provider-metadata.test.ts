import assert from "node:assert/strict";
import test from "node:test";

import {
  enrichProviderCallMetadata,
  providerCallMetadata
} from "../src/lib/fusion/provider-metadata.ts";

test("provider metadata captures Gateway generation and response identifiers", () => {
  const metadata = providerCallMetadata(
    {
      providerMetadata: {
        gateway: {
          generationId: "gen_123"
        }
      },
      response: {
        id: "resp_123",
        model: "anthropic/claude-opus-4.8",
        timestamp: new Date("2026-06-23T00:00:00.000Z"),
        headers: {
          "x-request-id": "req_123"
        }
      }
    },
    "anthropic/claude-opus-4.8"
  );

  assert.deepEqual(metadata, {
    model: "anthropic/claude-opus-4.8",
    provider: "gateway",
    generation_id: "gen_123",
    request_id: "req_123",
    response_id: "resp_123",
    response_model: "anthropic/claude-opus-4.8",
    timestamp: "2026-06-23T00:00:00.000Z"
  });
});

test("provider metadata is omitted when the SDK result has no identifiers", () => {
  assert.equal(providerCallMetadata({ usage: {} }, "test/model"), undefined);
});

test("provider metadata enriches Gateway generation cost and usage details", () => {
  const metadata = enrichProviderCallMetadata(
    {
      model: "openai/gpt-5.5",
      provider: "gateway",
      generation_id: "gen_456"
    },
    {
      id: "gen_456",
      totalCost: 0.0123,
      upstreamInferenceCost: 0.01,
      usage: 0.0123,
      createdAt: "2026-06-23T00:00:00.000Z",
      model: "openai/gpt-5.5",
      isByok: false,
      providerName: "openai",
      streamed: false,
      finishReason: "stop",
      latency: 350,
      generationTime: 1200,
      promptTokens: 100,
      completionTokens: 50,
      reasoningTokens: 10,
      cachedTokens: 5,
      cacheCreationTokens: 0,
      billableWebSearchCalls: 1
    }
  );

  assert.equal(metadata?.total_cost_usd, 0.0123);
  assert.equal(metadata?.provider_name, "openai");
  assert.equal(metadata?.prompt_tokens, 100);
  assert.equal(metadata?.billable_web_search_calls, 1);
});
