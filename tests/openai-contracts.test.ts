import assert from "node:assert/strict";
import test from "node:test";

import {
  openAICompletionFromRun,
  streamOpenAICompletion
} from "../src/lib/fusion/openai.ts";
import {
  OpenAIChatCompletionChunkSchema,
  OpenAIChatCompletionResponseSchema
} from "../src/lib/fusion/schemas.ts";
import type { FusionRun } from "../src/lib/fusion/types.ts";

function fixtureRun(status: FusionRun["status"] = "ok"): FusionRun {
  return {
    id: "run_openai",
    object: "fusion.run",
    created_at: "2026-06-23T00:00:00.000Z",
    completed_at: "2026-06-23T00:00:02.000Z",
    mode: "fusion-8",
    requested_model: "fusion/fusion-8",
    status,
    degraded: status !== "ok",
    failure_reason: status === "ok" ? undefined : "all_panels_failed",
    prompt: "Reply with exactly ok.",
    final: status === "ok" ? "ok" : "Fusion could not produce a useful result.",
    responses: [],
    failed_models: [],
    sources: [],
    usage: {
      input_tokens: 20,
      output_tokens: 2,
      total_tokens: 22
    },
    latency_ms: {
      panel_max: 1200,
      judge: 300,
      synthesis: 700,
      end_to_end: 2200
    },
    cost_usd: 0.0001,
    metadata: {
      trace_id: "trc_openai",
      panel_size: 8,
      panel_models: [
        "zai/glm-5.2",
        "openai/gpt-5.5",
        "anthropic/claude-opus-4.8",
        "google/gemini-3-pro-preview",
        "deepseek/deepseek-v4-pro",
        "alibaba/qwen3-max",
        "mistral/mistral-large-3",
        "meta/llama-4-maverick"
      ],
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
      cost_source: "gateway_generation",
      cost_coverage: {
        expected_provider_calls: 1,
        priced_provider_calls: 1,
        missing_provider_calls: 0,
        coverage_ratio: 1
      },
      provider_generations: [
        {
          model: "anthropic/claude-opus-4.8",
          provider: "gateway",
          generation_id: "gen_openai",
          total_cost_usd: 0.0001,
          provider_name: "anthropic",
          finish_reason: "stop"
        }
      ]
    }
  };
}

function toolCallRun(): FusionRun {
  const run = fixtureRun();
  return {
    ...run,
    final: "",
    metadata: {
      ...run.metadata,
      client_tool_calls: [
        {
          id: "call_read_file",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ path: "README.md" })
          }
        }
      ]
    }
  };
}

async function readStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      return text;
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
}

test("OpenAI completion response preserves Fusion metadata", () => {
  const response = openAICompletionFromRun(fixtureRun(), "fusion/fusion-8");
  const parsed = OpenAIChatCompletionResponseSchema.parse(response);

  assert.equal(parsed.object, "chat.completion");
  assert.equal(parsed.model, "fusion/fusion-8");
  assert.equal(parsed.choices[0]?.message.content, "ok");
  assert.equal(parsed.choices[0]?.finish_reason, "stop");
  assert.equal(parsed.usage.total_tokens, 22);
  assert.equal(parsed.fusion.run_id, "run_openai");
  assert.equal(parsed.fusion.mode, "fusion-8");
  assert.equal(parsed.fusion.panel_size, 8);
  assert.equal(parsed.fusion.cost_source, "gateway_generation");
  assert.equal(parsed.fusion.cost_coverage?.coverage_ratio, 1);
  assert.equal(parsed.fusion.provider_generations?.[0]?.generation_id, "gen_openai");
  assert.equal(parsed.fusion.provider_generations?.[0]?.total_cost_usd, 0.0001);
});

test("OpenAI completion response reports failed runs with error finish reason", () => {
  const response = openAICompletionFromRun(fixtureRun("error"), "fusion/fusion-8");
  const parsed = OpenAIChatCompletionResponseSchema.parse(response);

  assert.equal(parsed.choices[0]?.finish_reason, "error");
  assert.equal(parsed.fusion.status, "error");
  assert.equal(parsed.fusion.degraded, true);
});

test("OpenAI stream emits role, content, finish, and done chunks", async () => {
  const text = await readStream(streamOpenAICompletion(fixtureRun(), "fusion/fusion-8"));
  const events = text
    .trim()
    .split("\n\n")
    .map((event) => event.replace(/^data: /, ""));

  assert.equal(events.length, 4);
  assert.equal(events.at(-1), "[DONE]");

  const chunks = events.slice(0, -1).map((event) => JSON.parse(event));
  chunks.forEach((chunk) => {
    OpenAIChatCompletionChunkSchema.parse(chunk);
  });

  assert.equal(chunks[0].choices[0].delta.role, "assistant");
  assert.equal(chunks[1].choices[0].delta.content, "ok");
  assert.equal(chunks[1].fusion.run_id, "run_openai");
  assert.equal(chunks[1].fusion.cost_source, "gateway_generation");
  assert.equal(chunks[1].fusion.cost_coverage?.priced_provider_calls, 1);
  assert.equal(chunks[1].fusion.provider_generations?.[0]?.generation_id, "gen_openai");
  assert.equal(chunks[2].choices[0].finish_reason, "stop");
});

test("OpenAI stream emits indexed tool_call deltas", async () => {
  const text = await readStream(streamOpenAICompletion(toolCallRun(), "openrouter/fusion"));
  const events = text
    .trim()
    .split("\n\n")
    .map((event) => event.replace(/^data: /, ""));

  assert.equal(events.at(-1), "[DONE]");

  const chunks = events.slice(0, -1).map((event) => JSON.parse(event));
  chunks.forEach((chunk) => {
    OpenAIChatCompletionChunkSchema.parse(chunk);
  });

  assert.equal(chunks[0].choices[0].delta.role, "assistant");
  assert.equal(chunks[1].choices[0].delta.tool_calls[0].index, 0);
  assert.equal(chunks[1].choices[0].delta.tool_calls[0].id, "call_read_file");
  assert.equal(chunks[1].choices[0].delta.tool_calls[0].function.name, "read_file");
  assert.equal(chunks[2].choices[0].finish_reason, "tool_calls");
  assert.equal(chunks[2].choices[0].delta.tool_calls, undefined);
});
