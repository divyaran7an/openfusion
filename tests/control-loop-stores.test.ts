import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { saveComparison, listComparisons } from "../src/lib/fusion/comparison-store.ts";
import {
  activateCouncil,
  listCouncils,
  saveCouncil
} from "../src/lib/fusion/council-store.ts";
import { defaultGraph, type FusionGraph } from "../src/lib/fusion/graph.ts";
import { getActiveGraph } from "../src/lib/fusion/graph-store.ts";

function withDataDir<T>(run: (dir: string) => T): T {
  const previous = process.env.FUSION_DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), "fusion-control-loop-"));
  process.env.FUSION_DATA_DIR = dir;
  try {
    return run(dir);
  } finally {
    if (previous === undefined) delete process.env.FUSION_DATA_DIR;
    else process.env.FUSION_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

function namedGraph(name: string): FusionGraph {
  return { ...defaultGraph("2026-01-01T00:00:00.000Z"), name };
}

test("saved councils are listed with active and preset councils", () => {
  withDataDir(() => {
    const saved = saveCouncil({
      name: "Review Council",
      description: "Saved review graph",
      graph: namedGraph("review-council")
    });
    const councils = listCouncils();

    assert.ok(councils.some((council) => council.id === "active"));
    assert.ok(councils.some((council) => council.id === "fast-answer"));
    assert.ok(councils.some((council) => council.id === saved.id && council.source === "saved"));
  });
});

test("activateCouncil promotes a saved council to the active graph", () => {
  withDataDir(() => {
    const saved = saveCouncil({
      name: "Endpoint Winner",
      graph: namedGraph("endpoint-winner")
    });

    const active = activateCouncil(saved.id);
    assert.equal(active?.id, "active");
    assert.equal(getActiveGraph().name, "endpoint-winner");
  });
});

test("comparisons persist candidate runs in newest-first order", () => {
  withDataDir(() => {
    saveComparison({
      id: "cmp_old",
      task: "old task",
      target: "quality",
      candidate_council_ids: ["fast-answer"],
      runs: [
        {
          councilId: "fast-answer",
          councilName: "Fast Answer",
          score: { overall: 80 },
          metrics: { latencyMs: 1000, cost: 0.001, tokens: 100 }
        }
      ]
    });
    const latest = saveComparison({
      id: "cmp_new",
      task: "new task",
      target: "value",
      candidate_council_ids: ["budget-council"],
      runs: [
        {
          councilId: "budget-council",
          councilName: "Budget Council",
          score: { overall: 90 },
          metrics: { latencyMs: 2000, cost: 0.002, tokens: 200 }
        }
      ]
    });

    const records = listComparisons();
    assert.equal(records[0]?.id, latest.id);
    assert.equal(records[0]?.runs[0]?.councilId, "budget-council");
  });
});
