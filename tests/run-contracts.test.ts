import assert from "node:assert/strict";
import test from "node:test";

import {
  FusionResultSchema,
  FusionRunEventSchema,
  FusionRunSchema,
  SourceRecordSchema
} from "../src/lib/fusion/schemas.ts";
import type { FusionResult, FusionRun } from "../src/lib/fusion/types.ts";

function fixtureRun(): FusionRun {
  return {
    id: "run_contract",
    object: "fusion.run",
    created_at: "2026-06-23T00:00:00.000Z",
    completed_at: "2026-06-23T00:00:02.000Z",
    mode: "fast",
    requested_model: "fast",
    status: "ok",
    degraded: false,
    prompt: "Reply with exactly ok.",
    final: "ok",
    responses: [
      {
        model: "deepseek/deepseek-v4-pro",
        role: "panelist 1",
        content: "ok",
        usage: {
          input_tokens: 10,
          output_tokens: 1,
          total_tokens: 11
        },
        sources: [],
        latency_ms: 1200,
        provider_metadata: {
          model: "deepseek/deepseek-v4-pro",
          provider: "gateway",
          generation_id: "gen_panel"
        }
      }
    ],
    failed_models: [],
    sources: [],
    usage: {
      input_tokens: 20,
      output_tokens: 2,
      total_tokens: 22
    },
    latency_ms: {
      panel_max: 1200,
      judge: 0,
      synthesis: 700,
      end_to_end: 1900
    },
    cost_usd: 0.0001,
    metadata: {
      trace_id: "trc_contract",
      panel_size: 1,
      panel_models: ["deepseek/deepseek-v4-pro"],
      judge_model: "openai/gpt-5.5",
      outer_model: "anthropic/claude-opus-4.8",
      runtime: "gateway",
      web_enabled: true,
      web_tools_available: true,
      web_fetch_available: true,
      local_tools_enabled: true,
      local_tools_available: true,
      judge_web_tools_available: true,
      outer_web_tools_available: true,
      web_extract_available: false,
      thread_id: "thr_contract",
      turn_index: 0,
      cost_source: "gateway_generation",
      cost_coverage: {
        expected_provider_calls: 1,
        priced_provider_calls: 1,
        missing_provider_calls: 0,
        coverage_ratio: 1
      },
      provider_generations: [
        {
          model: "deepseek/deepseek-v4-pro",
          provider: "gateway",
          generation_id: "gen_panel",
          total_cost_usd: 0.0001,
          provider_name: "deepseek",
          finish_reason: "stop",
          prompt_tokens: 10,
          completion_tokens: 1
        }
      ]
    }
  };
}

function fixtureFusionResult(): FusionResult {
  return {
    object: "fusion.result",
    status: "ok",
    degraded: false,
    prompt: "Compare the options.",
    analysis: {
      consensus: ["Both options need operational review."],
      contradictions: [],
      partial_coverage: [],
      unique_insights: [],
      blind_spots: ["No deployment data was provided."]
    },
    responses: [
      {
        model: "deepseek/deepseek-v4-pro",
        role: "panelist 1",
        content: "Option A is simpler.",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15
        },
        sources: [],
        latency_ms: 1000,
        provider_metadata: {
          model: "deepseek/deepseek-v4-pro",
          provider: "gateway",
          generation_id: "gen_fusion_panel"
        }
      }
    ],
    failed_models: [],
    sources: [],
    usage: {
      input_tokens: 20,
      output_tokens: 10,
      total_tokens: 30
    },
    latency_ms: {
      panel_max: 1000,
      judge: 500,
      end_to_end: 1500
    },
    cost_usd: 0.0001,
    metadata: {
      trace_id: "trc_fusion",
      panel_size: 1,
      panel_models: ["deepseek/deepseek-v4-pro"],
      judge_model: "openai/gpt-5.5",
      outer_model: "anthropic/claude-opus-4.8",
      runtime: "gateway",
      web_enabled: true,
      web_tools_available: true,
      web_fetch_available: true,
      local_tools_enabled: true,
      local_tools_available: true,
      judge_web_tools_available: true,
      outer_web_tools_available: true,
      web_extract_available: false,
      thread_id: "thr_fusion",
      turn_index: 0,
      cost_source: "gateway_generation",
      cost_coverage: {
        expected_provider_calls: 1,
        priced_provider_calls: 1,
        missing_provider_calls: 0,
        coverage_ratio: 1
      },
      provider_generations: [
        {
          model: "deepseek/deepseek-v4-pro",
          provider: "gateway",
          generation_id: "gen_fusion_panel",
          total_cost_usd: 0.0001,
          provider_name: "deepseek",
          finish_reason: "stop",
          prompt_tokens: 10,
          completion_tokens: 5
        }
      ]
    }
  };
}

test("FusionRunSchema accepts the public run envelope", () => {
  const parsed = FusionRunSchema.parse(fixtureRun());
  assert.equal(parsed.object, "fusion.run");
  assert.equal(parsed.metadata.runtime, "gateway");
  assert.equal(parsed.metadata.thread_id, "thr_contract");
  assert.equal(parsed.metadata.turn_index, 0);
  assert.equal(parsed.metadata.cost_source, "gateway_generation");
  assert.equal(parsed.metadata.cost_coverage?.priced_provider_calls, 1);
  assert.equal(parsed.metadata.cost_coverage?.missing_provider_calls, 0);
  assert.equal(parsed.responses[0]?.provider_metadata?.generation_id, "gen_panel");
  assert.equal(parsed.metadata.provider_generations?.[0]?.generation_id, "gen_panel");
  assert.equal(parsed.metadata.provider_generations?.[0]?.total_cost_usd, 0.0001);
});

test("FusionRunSchema rejects malformed run envelopes", () => {
  const malformed = {
    ...fixtureRun(),
    usage: {
      input_tokens: -1,
      output_tokens: 2,
      total_tokens: 1
    }
  };

  assert.equal(FusionRunSchema.safeParse(malformed).success, false);
});

test("FusionResultSchema accepts analysis-only server tool results", () => {
  const parsed = FusionResultSchema.parse(fixtureFusionResult());
  assert.equal(parsed.object, "fusion.result");
  assert.equal(parsed.metadata.panel_size, 1);
  assert.equal(parsed.metadata.provider_generations?.[0]?.provider_name, "deepseek");
  assert.equal("final" in parsed, false);

  assert.equal(
    FusionResultSchema.safeParse({
      ...fixtureFusionResult(),
      object: "fusion.run"
    }).success,
    false
  );
});

test("SourceRecordSchema accepts optional citation metadata", () => {
  const parsed = SourceRecordSchema.parse({
    title: "Research note",
    url: "https://example.com/fusion",
    snippet: "Evidence summary.",
    provider: "webFetch",
    metadata: {
      canonical_url: "https://example.com/fusion",
      site_name: "Example",
      published_at: "2026-06-20T00:00:00Z",
      fetched_at: "2026-06-23T00:00:00Z",
      mime_type: "text/html",
      status: 200
    }
  });

  assert.equal(parsed.metadata?.site_name, "Example");
  assert.equal(parsed.metadata?.status, 200);
});

test("FusionRunEventSchema accepts known runtime event types only", () => {
  const valid = {
    id: "evt_contract",
    object: "fusion.run.event",
    run_id: "run_contract",
    sequence: 0,
    type: "run.started",
    created_at: "2026-06-23T00:00:00.000Z",
    data: { trace_id: "trc_contract" }
  };

  assert.equal(FusionRunEventSchema.safeParse(valid).success, true);
  assert.equal(
    FusionRunEventSchema.safeParse({
      ...valid,
      type: "tool.started"
    }).success,
    true
  );
  assert.equal(
    FusionRunEventSchema.safeParse({
      ...valid,
      type: "tool.finished"
    }).success,
    true
  );
  assert.equal(
    FusionRunEventSchema.safeParse({
      ...valid,
      type: "tool.failed"
    }).success,
    true
  );
  assert.equal(
    FusionRunEventSchema.safeParse({
      ...valid,
      type: "tool.called"
    }).success,
    false
  );
});
