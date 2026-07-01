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

test("provider metadata captures OpenRouter response identifiers", () => {
  const metadata = providerCallMetadata(
    {
      providerMetadata: {
        openrouter: {
          provider: "anthropic"
        }
      },
      response: {
        id: "gen_or_123",
        model: "anthropic/claude-opus-4.8",
        headers: {
          "x-openrouter-request-id": "req_or_123"
        }
      }
    },
    "openrouter/anthropic/claude-opus-4.8",
    "openrouter"
  );

  assert.deepEqual(metadata, {
    model: "openrouter/anthropic/claude-opus-4.8",
    provider: "openrouter",
    generation_id: "gen_or_123",
    request_id: "req_or_123",
    response_id: "gen_or_123",
    response_model: "anthropic/claude-opus-4.8",
    timestamp: undefined,
    provider_name: "anthropic",
    total_cost_usd: undefined,
    upstream_inference_cost_usd: undefined,
    prompt_tokens: undefined,
    completion_tokens: undefined,
    reasoning_tokens: undefined,
    cached_tokens: undefined
  });
});

test("provider metadata captures OpenRouter direct usage accounting", () => {
  const metadata = providerCallMetadata(
    {
      providerMetadata: {
        openrouter: {
          provider: "openai",
          usage: {
            promptTokens: 100,
            promptTokensDetails: {
              cachedTokens: 25
            },
            completionTokens: 40,
            completionTokensDetails: {
              reasoningTokens: 8
            },
            totalTokens: 140,
            cost: 0.0042,
            costDetails: {
              upstreamInferenceCost: 0.0037
            }
          }
        }
      },
      response: {
        id: "gen_or_usage",
        model: "openai/gpt-5.5"
      }
    },
    "openrouter/openai/gpt-5.5",
    "openrouter"
  );

  assert.equal(metadata?.provider_name, "openai");
  assert.equal(metadata?.total_cost_usd, 0.0042);
  assert.equal(metadata?.upstream_inference_cost_usd, 0.0037);
  assert.equal(metadata?.prompt_tokens, 100);
  assert.equal(metadata?.completion_tokens, 40);
  assert.equal(metadata?.reasoning_tokens, 8);
  assert.equal(metadata?.cached_tokens, 25);
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
