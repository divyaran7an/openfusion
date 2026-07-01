import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultGraph,
  graphToOverride,
  nodeModelId,
  validateGraph,
  type FusionGraph,
  type GraphNode
} from "../src/lib/fusion/graph.ts";

function node(partial: Partial<GraphNode> & Pick<GraphNode, "id" | "role" | "source" | "model">): GraphNode {
  return { position: { x: 0, y: 0 }, ...partial };
}

function graph(nodes: GraphNode[]): FusionGraph {
  return {
    object: "fusion.graph",
    id: "active",
    name: "fusion",
    max_tool_calls: 8,
    updated_at: "2026-06-26T00:00:00.000Z",
    nodes
  };
}

test("nodeModelId namespaces non-Gateway sources but leaves Gateway ids bare", () => {
  assert.equal(nodeModelId({ source: "gateway", model: "openai/gpt-5.5" }), "openai/gpt-5.5");
  assert.equal(
    nodeModelId({ source: "openrouter", model: "anthropic/claude-opus-4.8" }),
    "openrouter/anthropic/claude-opus-4.8"
  );
  assert.equal(nodeModelId({ source: "claude-code", model: "opus" }), "claude-code/opus");
  assert.equal(nodeModelId({ source: "codex", model: "gpt-5.5-codex" }), "codex/gpt-5.5-codex");
});

test("validateGraph requires at least one panel and exactly one synthesizer", () => {
  assert.deepEqual(validateGraph(graph([])).ok, false);

  const noSynth = validateGraph(graph([node({ id: "p", role: "panel", source: "gateway", model: "a" })]));
  assert.equal(noSynth.ok, false);

  const twoSynths = validateGraph(
    graph([
      node({ id: "p", role: "panel", source: "gateway", model: "a" }),
      node({ id: "s1", role: "synthesizer", source: "gateway", model: "b" }),
      node({ id: "s2", role: "synthesizer", source: "gateway", model: "c" })
    ])
  );
  assert.equal(twoSynths.ok, false);

  const ok = validateGraph(
    graph([
      node({ id: "p", role: "panel", source: "gateway", model: "a" }),
      node({ id: "s", role: "synthesizer", source: "gateway", model: "b" })
    ])
  );
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.errors, []);
});

test("validateGraph rejects a node with a blank model", () => {
  const blank = validateGraph(
    graph([
      node({ id: "p", role: "panel", source: "gateway", model: "" }),
      node({ id: "s", role: "synthesizer", source: "gateway", model: "b" })
    ])
  );
  assert.equal(blank.ok, false);
  assert.equal(
    blank.errors.some((error) => error.toLowerCase().includes("model")),
    true
  );
});

test("graphToOverride carries council temperature and strict mode through", () => {
  const base = [
    node({ id: "p", role: "panel", source: "gateway", model: "a" }),
    node({ id: "s", role: "synthesizer", source: "gateway", model: "b" })
  ];

  // Defaults: no temperature override, strict off.
  const plain = graphToOverride(graph(base));
  assert.equal(plain.temperature, undefined);
  assert.equal(plain.strict, false);

  // Set on the graph → present on the override the orchestrator reads.
  const tuned = graphToOverride({ ...graph(base), temperature: 0.9, strict: true });
  assert.equal(tuned.temperature, 0.9);
  assert.equal(tuned.strict, true);
});

test("graphToOverride emits per-node effort and web config aligned with the panel", () => {
  const override = graphToOverride(
    graph([
      node({ id: "p1", role: "panel", source: "gateway", model: "a", effort: "low", web: true }),
      node({ id: "p2", role: "panel", source: "claude-code", model: "opus", effort: "high" }),
      node({ id: "j", role: "judge", source: "gateway", model: "j", effort: "minimal" }),
      node({ id: "s", role: "synthesizer", source: "gateway", model: "s", effort: "high", web: false })
    ])
  );

  assert.deepEqual(override.panel_models, ["a", "claude-code/opus"]);
  assert.equal(override.judge_model, "j");
  assert.equal(override.outer_model, "s");

  // panel_config is index-aligned with panel_models.
  assert.deepEqual(override.panel_config, [
    { effort: "low", web: true },
    { effort: "high", web: true }
  ]);
  assert.deepEqual(override.judge_config, { effort: "minimal", web: true });
  assert.deepEqual(override.synth_config, { effort: "high", web: false });

  // Web tool configs attach because panel/judge default on, unless explicitly disabled.
  assert.ok(override.web_search);
  assert.ok(override.web_fetch);
});

test("graphToOverride defaults panel and judge web on, synthesizer web off", () => {
  const override = graphToOverride(
    graph([
      node({ id: "p", role: "panel", source: "gateway", model: "a" }),
      node({ id: "j", role: "judge", source: "gateway", model: "j" }),
      node({ id: "s", role: "synthesizer", source: "gateway", model: "b" })
    ])
  );

  assert.deepEqual(override.panel_config, [{ effort: undefined, web: true }]);
  assert.deepEqual(override.judge_config, { effort: undefined, web: true });
  assert.deepEqual(override.synth_config, { effort: undefined, web: false });
  assert.ok(override.web_search);
  assert.ok(override.web_fetch);
});

test("a judge is optional: a multi-panel council with no judge node is valid", () => {
  const noJudge = graph([
    node({ id: "p1", role: "panel", source: "gateway", model: "a" }),
    node({ id: "p2", role: "panel", source: "gateway", model: "b" }),
    node({ id: "s", role: "synthesizer", source: "gateway", model: "c" })
  ]);
  assert.equal(validateGraph(noJudge).ok, true);

  const override = graphToOverride(noJudge);
  // No judge node => no judge model is ever invented.
  assert.equal(override.judge_model, undefined);
  assert.equal(override.judge_config, undefined);
  assert.deepEqual(override.panel_models, ["a", "b"]);
  assert.equal(override.outer_model, "c");
});

test("graphToOverride omits web tool configs when web is explicitly disabled everywhere", () => {
  const override = graphToOverride(
    graph([
      node({ id: "p", role: "panel", source: "gateway", model: "a", web: false }),
      node({ id: "j", role: "judge", source: "gateway", model: "j", web: false }),
      node({ id: "s", role: "synthesizer", source: "gateway", model: "b", web: false })
    ])
  );
  assert.equal(override.web_search, undefined);
  assert.equal(override.web_fetch, undefined);
  assert.deepEqual(override.panel_config, [{ effort: undefined, web: false }]);
  assert.deepEqual(override.judge_config, { effort: undefined, web: false });
  assert.deepEqual(override.synth_config, { effort: undefined, web: false });
});

test("graphToOverride caps the panel at 8 nodes", () => {
  const panels = Array.from({ length: 12 }, (_, i) =>
    node({ id: `p${i}`, role: "panel", source: "gateway", model: `m${i}` })
  );
  const override = graphToOverride(
    graph([...panels, node({ id: "s", role: "synthesizer", source: "gateway", model: "s" })])
  );
  assert.equal(override.panel_models?.length, 8);
  assert.equal(override.panel_config?.length, 8);
});

test("the seed graph is valid and round-trips into an override", () => {
  const seed = defaultGraph("2026-06-26T00:00:00.000Z");
  assert.equal(validateGraph(seed).ok, true);
  const override = graphToOverride(seed);
  assert.equal(override.panel_models?.length, 3);
  assert.equal(override.outer_model, "anthropic/claude-opus-4.8");
  assert.equal(override.judge_config?.web, true);
  assert.deepEqual(override.panel_config?.map((config) => config.web), [true, true, true]);
  assert.equal(override.synth_config?.web, false);
});
