import assert from "node:assert/strict";
import test from "node:test";

import {
  aliasesForMode,
  clientModelAliases,
  FUSION_PRESETS,
  modeFromModel
} from "../src/lib/fusion/models.ts";
import {
  OpenAIChatCompletionRequestSchema,
  RunRequestSchema
} from "../src/lib/fusion/schemas.ts";

test("modeFromModel accepts public, compatibility, and short aliases", () => {
  assert.equal(modeFromModel(), "openfusion");
  assert.equal(modeFromModel("openfusion"), "openfusion");
  assert.equal(modeFromModel("fusion/fast"), "fast");
  assert.equal(modeFromModel("fusion/fast"), "fast");
  assert.equal(modeFromModel("fast"), "fast");
  assert.equal(modeFromModel("fusion/research"), "research");
  assert.equal(modeFromModel("fusion/research"), "research");
  assert.equal(modeFromModel("research"), "research");
  assert.equal(modeFromModel("openrouter/fusion"), "openfusion");
  assert.equal(modeFromModel("fusion/fusion"), "openfusion");
  assert.equal(modeFromModel("fusion/fusion"), "openfusion");
  assert.equal(modeFromModel("fusion"), "openfusion");
  assert.equal(modeFromModel("fusion/fusion-3"), "fusion-3");
  assert.equal(modeFromModel("fusion/fusion-3"), "fusion-3");
  assert.equal(modeFromModel("fusion-3"), "fusion-3");
  assert.equal(modeFromModel("fusion/fusion-8"), "fusion-8");
  assert.equal(modeFromModel("fusion/fusion-8"), "fusion-8");
  assert.equal(modeFromModel("fusion-8"), "fusion-8");
});

test("modeFromModel rejects unknown client model IDs clearly", () => {
  assert.throws(
    () => modeFromModel("openai/gpt-5.5"),
    /Unsupported Fusion model alias/
  );
});

test("custom client model aliases map forced client IDs to Fusion modes", () => {
  const previous = process.env.FUSION_MODEL_ALIASES;
  process.env.FUSION_MODEL_ALIASES = [
    "gpt-5.4=fusion-8",
    "composer-2.5-fast:fast",
    "bad-entry",
    "fusion/fast=fusion-8"
  ].join(",");

  try {
    assert.deepEqual(clientModelAliases(), [
      { alias: "gpt-5.4", mode: "fusion-8" },
      { alias: "composer-2.5-fast", mode: "fast" }
    ]);
    assert.equal(modeFromModel("gpt-5.4"), "fusion-8");
    assert.equal(modeFromModel("composer-2.5-fast"), "fast");
    assert.equal(modeFromModel("fusion/fast"), "fast");
    assert.ok(aliasesForMode("fusion-8").includes("gpt-5.4"));
  } finally {
    if (previous === undefined) {
      delete process.env.FUSION_MODEL_ALIASES;
    } else {
      process.env.FUSION_MODEL_ALIASES = previous;
    }
  }
});

test("presets preserve the advertised Fusion panel sizes", () => {
  assert.equal(FUSION_PRESETS.openfusion.panelModels.length, 3);
  assert.equal(FUSION_PRESETS.fast.panelModels.length, 1);
  assert.equal(FUSION_PRESETS.research.panelModels.length, 1);
  assert.equal(FUSION_PRESETS["fusion-3"].panelModels.length, 3);
  assert.equal(FUSION_PRESETS["fusion-8"].panelModels.length, 8);
});

test("run and OpenAI request schemas require real user input", () => {
  assert.equal(RunRequestSchema.safeParse({ prompt: "research this" }).success, true);
  assert.equal(
    RunRequestSchema.safeParse({ messages: [{ role: "user", content: "go" }] }).success,
    true
  );
  assert.equal(RunRequestSchema.safeParse({ messages: [] }).success, false);
  assert.equal(
    OpenAIChatCompletionRequestSchema.safeParse({
      model: "fusion/fast",
      messages: [{ role: "user", content: "ok" }],
      max_completion_tokens: 128,
      n: 1,
      stop: ["</answer>"],
      top_p: 0.9,
      presence_penalty: 0,
      frequency_penalty: 0,
      seed: 42,
      parallel_tool_calls: true,
      stream_options: { include_usage: true },
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              answer: { type: "string" }
            },
            required: ["answer"]
          },
          strict: true
        }
      },
      tools: [{ type: "openrouter:fusion" }],
      functions: [
        {
          name: "read_file",
          description: "Read a file from the client workspace.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" }
            },
            required: ["path"]
          }
        }
      ],
      function_call: { name: "read_file" },
      plugins: [{ id: "fusion", analysis_models: ["openai/gpt-5.5"] }]
    }).success,
    true
  );
  assert.equal(
    OpenAIChatCompletionRequestSchema.safeParse({
      model: "fusion/fast",
      messages: [
        {
          role: "developer",
          content: [{ type: "text", text: "Keep replies tight." }]
        },
        {
          role: "user",
          content: [{ type: "text", text: "ok" }]
        }
      ]
    }).success,
    true
  );
  assert.equal(
    RunRequestSchema.safeParse({
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }]
    }).success,
    true
  );
  assert.equal(
    OpenAIChatCompletionRequestSchema.safeParse({
      model: "fusion/fast",
      messages: []
    }).success,
    false
  );
});
