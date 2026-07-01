import { test } from "node:test";
import assert from "node:assert/strict";

import { reduceActivity, type ActivityNode } from "../src/lib/fusion/activity-log.ts";
import type { FusionRunEvent } from "../src/lib/fusion/types.ts";

let sequence = 0;
function event(type: FusionRunEvent["type"], data: Record<string, unknown>): FusionRunEvent {
  sequence += 1;
  return {
    id: `evt_${sequence}`,
    object: "fusion.run.event",
    run_id: "run_test",
    sequence,
    type,
    created_at: "2026-06-27T00:00:00.000Z",
    data: { trace_id: "trc_test", ...data }
  };
}

function fold(events: FusionRunEvent[]): ActivityNode[] {
  return events.reduce<ActivityNode[]>(reduceActivity, []);
}

test("a panel run becomes one row that goes running → done with its answer", () => {
  // Real lifecycle events carry a display label ("panelist 1") in data.role, not
  // the structural role — the reducer must group by event type regardless.
  const nodes = fold([
    event("run.started", { panel_size: 1 }),
    event("panel.started", { role: "panelist 1", index: 0, model: "openai/gpt-5.5" }),
    event("panel.finished", {
      role: "panelist 1",
      index: 0,
      model: "openai/gpt-5.5",
      text: "Postgres for concurrency.",
      usage: { total_tokens: 412 }
    }),
    event("run.completed", { status: "ok" })
  ]);

  assert.equal(nodes.length, 1, "run.started/run.completed don't create rows");
  const [panel] = nodes;
  assert.equal(panel.key, "panel:0");
  assert.equal(panel.role, "panel");
  assert.equal(panel.label, "Panel 1");
  assert.equal(panel.status, "done");
  assert.equal(panel.text, "Postgres for concurrency.");
  assert.equal(panel.tokens, 412);
});

test("tool events attach to the right node and dedupe by call id", () => {
  const nodes = fold([
    event("panel.started", { role: "panel", index: 1, model: "google/gemini-3-pro-preview" }),
    event("node.tool.finished", {
      role: "panel",
      index: 1,
      tool: "web_search",
      call_id: "call_a",
      args: { query: "sqlite wal mode" },
      result: { results: [{ title: "WAL" }] }
    }),
    // A second event for the same call id (e.g. a later step settling) updates,
    // not duplicates, the row.
    event("node.tool.finished", {
      role: "panel",
      index: 1,
      tool: "web_search",
      call_id: "call_a",
      args: { query: "sqlite wal mode" },
      result: { results: [{ title: "WAL", url: "https://sqlite.org" }] }
    }),
    event("panel.finished", { role: "panel", index: 1 })
  ]);

  const panel = nodes.find((n) => n.key === "panel:1");
  assert.ok(panel);
  assert.equal(panel.tools.length, 1, "same call_id collapses to one tool row");
  assert.equal(panel.tools[0].tool, "web_search");
  assert.equal(panel.tools[0].status, "done");
  assert.deepEqual(panel.tools[0].args, { query: "sqlite wal mode" });
});

test("judge and synthesizer rows are singletons keyed by role", () => {
  const nodes = fold([
    event("judge.started", { model: "openai/gpt-5.5", response_count: 3 }),
    event("node.tool.failed", { role: "judge", tool: "web_search", call_id: "j1" }),
    event("judge.finished", { model: "openai/gpt-5.5", usage: { input_tokens: 100, output_tokens: 50 } }),
    event("synthesis.started", { model: "anthropic/claude-opus-4.8" }),
    event("synthesis.finished", { model: "anthropic/claude-opus-4.8" })
  ]);

  const judge = nodes.find((n) => n.key === "judge");
  const synth = nodes.find((n) => n.key === "synthesizer");
  assert.ok(judge);
  assert.ok(synth);
  assert.equal(judge.status, "done");
  assert.equal(judge.tokens, 150, "input+output tokens sum when no total is given");
  assert.equal(judge.tools.length, 1);
  assert.equal(judge.tools[0].status, "failed");
  assert.equal(synth.status, "done");
});

test("node.delta chunks accumulate into the node's streamed text", () => {
  const nodes = fold([
    event("synthesis.started", { role: "synthesizer", model: "anthropic/claude-opus-4.8" }),
    event("node.delta", { role: "synthesizer", text: "The consensus " }),
    event("node.delta", { role: "synthesizer", text: "is Postgres." }),
    event("synthesis.finished", { role: "synthesizer", model: "anthropic/claude-opus-4.8" })
  ]);

  const synth = nodes.find((n) => n.key === "synthesizer");
  assert.ok(synth);
  assert.equal(synth.text, "The consensus is Postgres.");
  assert.equal(synth.status, "done");
});

test("a panel's streamed deltas are superseded by the trimmed finished text", () => {
  const nodes = fold([
    event("panel.started", { role: "panel", index: 0, model: "a" }),
    event("node.delta", { role: "panel", index: 0, text: "Answer body  " }),
    event("panel.finished", { role: "panel", index: 0, model: "a", text: "Answer body" })
  ]);
  assert.equal(nodes[0].text, "Answer body", "finished text replaces the accumulated stream");
});

test("a failed node keeps its error reason for the drawer to show", () => {
  const nodes = fold([
    event("panel.started", { role: "panel", index: 0, model: "meta/llama-4-maverick" }),
    event("panel.failed", {
      role: "panel",
      index: 0,
      model: "meta/llama-4-maverick",
      error: "model not found: meta/llama-4-maverick"
    }),
    // Falls back to failure_reason when no raw error string is present.
    event("synthesis.started", { role: "synthesizer", model: "codex/gpt-5.5-codex" }),
    event("synthesis.failed", { role: "synthesizer", model: "codex/gpt-5.5-codex", failure_reason: "harness_error" })
  ]);

  const panel = nodes.find((n) => n.key === "panel:0");
  const synth = nodes.find((n) => n.key === "synthesizer");
  assert.equal(panel?.status, "failed");
  assert.equal(panel?.error, "model not found: meta/llama-4-maverick");
  assert.equal(synth?.error, "harness_error");
});

test("a failed panel still completes as its own row, ordered by first appearance", () => {
  const nodes = fold([
    event("panel.started", { role: "panel", index: 0, model: "a" }),
    event("panel.started", { role: "panel", index: 1, model: "b" }),
    event("panel.failed", { role: "panel", index: 1, model: "b" }),
    event("panel.finished", { role: "panel", index: 0, model: "a" })
  ]);

  assert.deepEqual(
    nodes.map((n) => n.key),
    ["panel:0", "panel:1"],
    "rows stay in first-seen order regardless of which finishes first"
  );
  assert.equal(nodes[0].status, "done");
  assert.equal(nodes[1].status, "failed");
});
