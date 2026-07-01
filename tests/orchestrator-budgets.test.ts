import assert from "node:assert/strict";
import test from "node:test";

import { FUSION_PRESETS } from "../src/lib/fusion/models.ts";
import { outerModelForAgenticRequest } from "../src/lib/fusion/orchestrator.ts";
import { outputBudgetsForRequest } from "../src/lib/fusion/output-budgets.ts";

test("Fusion and OpenAI completion-token caps stay separate", () => {
  const budgets = outputBudgetsForRequest({
    fusion: { max_completion_tokens: 4096 },
    max_completion_tokens: 256,
    max_tokens: 128
  });

  assert.equal(budgets.inner, 4096);
  assert.equal(budgets.final, 256);
});

test("legacy max_tokens still caps the final answer when max_completion_tokens is absent", () => {
  const budgets = outputBudgetsForRequest({
    fusion: undefined,
    max_completion_tokens: undefined,
    max_tokens: 128
  });

  assert.equal(budgets.inner, undefined);
  assert.equal(budgets.final, 128);
});

test("agentic Fusion uses the graph synthesizer, not the caller's model label", () => {
  const preset = FUSION_PRESETS.openfusion;

  assert.equal(
    outerModelForAgenticRequest(
      {
        model: "gpt-4o",
        fusion: { outer_model: "claude-code/opus" }
      } as Parameters<typeof outerModelForAgenticRequest>[0],
      preset
    ),
    "claude-code/opus"
  );

  assert.equal(
    outerModelForAgenticRequest(
      { model: "openfusion" } as Parameters<typeof outerModelForAgenticRequest>[0],
      preset
    ),
    preset.outerModel
  );
});
