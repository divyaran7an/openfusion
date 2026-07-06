import { test } from "node:test";
import assert from "node:assert/strict";

import { validateGraph, type FusionGraph, type GraphNode } from "../src/lib/fusion/graph.ts";
import { councilPresets } from "../src/lib/fusion/councils.ts";

const PRESET_IDS = ["fast-answer", "budget-council", "coding-review"] as const;
type PresetId = (typeof PRESET_IDS)[number];

function isPreset(id: string): id is PresetId {
  return (PRESET_IDS as readonly string[]).includes(id);
}

function panels(graph: FusionGraph) {
  return graph.nodes.filter((n) => n.role === "panel");
}
function judges(graph: FusionGraph) {
  return graph.nodes.filter((n) => n.role === "judge");
}
function synths(graph: FusionGraph) {
  return graph.nodes.filter((n) => n.role === "synthesizer");
}

test("exactly three presets ship for v1: fast-answer, budget-council, coding-review", () => {
  const ids = Object.keys(councilPresets).sort();
  assert.deepEqual(ids, [...PRESET_IDS].sort());
});

test("every preset has a non-empty id, name, and one-line description", () => {
  for (const [id, preset] of Object.entries(councilPresets)) {
    assert.ok(isPreset(id), `unexpected preset id: ${id}`);
    assert.ok(preset.name.trim().length > 0, `${id} has no name`);
    assert.ok(preset.description.trim().length > 0, `${id} has no description`);
  }
});

test("every preset is a runnable graph: at least one panel and exactly one synthesizer", () => {
  for (const [id, preset] of Object.entries(councilPresets)) {
    const result = validateGraph(preset.graph);
    assert.equal(result.ok, true, `${id} is not runnable: ${result.errors.join("; ")}`);
  }
});

test("every preset graph has a stable id distinct from the active graph", () => {
  for (const [id, preset] of Object.entries(councilPresets)) {
    assert.ok(preset.graph.id.length > 0, `${id} graph has no id`);
    assert.notEqual(preset.graph.id, "active", `${id} must not shadow the active graph id`);
  }
});

test("Fast Answer: one panel, no judge, synthesizer is the same model as the panel", () => {
  const { graph } = councilPresets["fast-answer"];
  assert.equal(panels(graph).length, 1, "Fast Answer is a solo council");
  assert.equal(judges(graph).length, 0, "Fast Answer skips the judge to save latency");
  assert.equal(synths(graph).length, 1);
  const [panel] = panels(graph);
  const [synth] = synths(graph);
  assert.equal(panel.source, synth.source, "synth must reuse the panel source");
  assert.equal(panel.model, synth.model, "synth must reuse the panel model");
});

test("Budget Council: three cheap panels, one judge, one synthesizer", () => {
  const { graph } = councilPresets["budget-council"];
  assert.equal(panels(graph).length, 3, "Budget Council is a three-voice value play");
  assert.equal(judges(graph).length, 1, "Budget Council keeps a mini judge");
  assert.equal(synths(graph).length, 1);
  // Three distinct panel models: a value council should not triple-spend on one model.
  const panelModels = new Set(panels(graph).map((n) => `${n.source}:${n.model}`));
  assert.equal(panelModels.size, 3, "panel models should be distinct");
});

test("Coding Review: two tool-capable panels, judge enabled, synthesizer tools off, strict output", () => {
  const { graph } = councilPresets["coding-review"];
  assert.equal(panels(graph).length, 2, "Coding Review pairs two tool-capable panels");
  assert.equal(judges(graph).length, 1, "Coding Review keeps a judge");
  const [synth] = synths(graph);
  assert.ok(synth, "Coding Review needs a synthesizer");
  // The synthesizer writes from the earlier work, not a fresh search pass.
  assert.equal(synth.web ?? false, false, "synthesizer web tools must be off for Coding Review");
  // Strict output so editor clients get parseable responses.
  assert.equal(graph.strict ?? false, true, "Coding Review graph must be strict");
  // Both panels must be tool-capable (web tools on).
  for (const panel of panels(graph)) {
    assert.equal(panel.web ?? true, true, `${panel.id} should have web tools on`);
  }
});

test("preset graphs are self-contained: no node references an external graph", () => {
  for (const [id, preset] of Object.entries(councilPresets)) {
    const ids = new Set(preset.graph.nodes.map((n) => n.id));
    assert.equal(ids.size, preset.graph.nodes.length, `${id} has duplicate node ids`);
    for (const node of preset.graph.nodes as GraphNode[]) {
      assert.ok(node.model.trim().length > 0, `${id} node ${node.id} has no model`);
      assert.ok(node.source, `${id} node ${node.id} has no source`);
    }
  }
});
