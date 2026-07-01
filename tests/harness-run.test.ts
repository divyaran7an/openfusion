import assert from "node:assert/strict";
import test from "node:test";

import {
  claudeEffort,
  codexEffort,
  extractCodexError,
  extractCodexFallbackText,
  extractCodexUsage,
  parseClaudeResult
} from "../src/lib/fusion/harness-run.ts";

test("parseClaudeResult extracts text, usage and cost from --output-format json", () => {
  const stdout = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "the answer",
    total_cost_usd: 0.0123,
    usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 50 }
  });
  const parsed = parseClaudeResult(stdout);
  assert.equal(parsed.text, "the answer");
  assert.equal(parsed.usage.input_tokens, 15);
  assert.equal(parsed.usage.output_tokens, 50);
  assert.equal(parsed.usage.total_tokens, 65);
  assert.equal(parsed.cost, 0.0123);
});

test("parseClaudeResult tolerates a banner line before the JSON object", () => {
  const stdout = `startup banner\n${JSON.stringify({
    result: "ok",
    usage: { input_tokens: 1, output_tokens: 2 }
  })}`;
  const parsed = parseClaudeResult(stdout);
  assert.equal(parsed.text, "ok");
  assert.equal(parsed.usage.total_tokens, 3);
});

test("parseClaudeResult throws on an error result", () => {
  assert.throws(() => parseClaudeResult(JSON.stringify({ is_error: true, result: "boom" })), /boom/);
});

test("extractCodexUsage finds token counts across event shapes", () => {
  const lines = [
    JSON.stringify({ id: "1", msg: { type: "agent_message", message: "hi" } }),
    JSON.stringify({ type: "token_count", info: { input_tokens: 12, output_tokens: 34 } })
  ].join("\n");
  const usage = extractCodexUsage(lines);
  assert.equal(usage.input_tokens, 12);
  assert.equal(usage.output_tokens, 34);
  assert.equal(usage.total_tokens, 46);
});

test("extractCodexUsage returns zeros when no usage event is present", () => {
  const usage = extractCodexUsage(JSON.stringify({ msg: { type: "agent_message", message: "hi" } }));
  assert.equal(usage.total_tokens, 0);
});

test("extractCodexFallbackText returns the last agent message", () => {
  const lines = [
    JSON.stringify({ msg: { type: "agent_message", message: "first" } }),
    JSON.stringify({ msg: { type: "agent_message", message: "final" } })
  ].join("\n");
  assert.equal(extractCodexFallbackText(lines), "final");
});

test("extractCodexFallbackText reads the newer item.completed agent_message shape", () => {
  const lines = [
    JSON.stringify({ type: "thread.started", thread_id: "t" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } })
  ].join("\n");
  assert.equal(extractCodexFallbackText(lines), "hello");
});

test("extractCodexUsage reads a turn.completed usage block", () => {
  const usage = extractCodexUsage(
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 7, output_tokens: 8 } })
  );
  assert.equal(usage.input_tokens, 7);
  assert.equal(usage.output_tokens, 8);
  assert.equal(usage.total_tokens, 15);
});

test("extractCodexError surfaces the last error / turn.failed message", () => {
  const lines = [
    JSON.stringify({ type: "error", message: "transient" }),
    JSON.stringify({ type: "turn.failed", error: { message: "model not supported" } })
  ].join("\n");
  assert.equal(extractCodexError(lines), "model not supported");
});

test("effort maps to each CLI's own vocabulary (matching T3 Code's tiers)", () => {
  assert.equal(claudeEffort("minimal"), "low");
  assert.equal(claudeEffort("medium"), "medium");
  assert.equal(claudeEffort("high"), "high");
  // Only opus-class Claude models accept the top `xhigh` tier; others cap at high.
  assert.equal(claudeEffort("max"), "high");
  assert.equal(claudeEffort("max", "sonnet"), "high");
  assert.equal(claudeEffort("max", "opus"), "xhigh");
  // Codex accepts minimal | low | medium | high | xhigh, so `max` → `xhigh`.
  assert.equal(codexEffort("minimal"), "minimal");
  assert.equal(codexEffort("medium"), "medium");
  assert.equal(codexEffort("max"), "xhigh");
});
