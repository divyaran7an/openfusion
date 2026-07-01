import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { defaultGraph } from "../src/lib/fusion/graph.ts";
import { getActiveGraph, saveActiveGraph } from "../src/lib/fusion/graph-store.ts";

function withDataDir<T>(run: (dir: string) => T): T {
  const previous = process.env.FUSION_DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), "fusion-graph-store-"));
  process.env.FUSION_DATA_DIR = dir;
  try {
    return run(dir);
  } finally {
    if (previous === undefined) delete process.env.FUSION_DATA_DIR;
    else process.env.FUSION_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("getActiveGraph returns the seed graph when nothing is persisted", () => {
  withDataDir(() => {
    const graph = getActiveGraph();
    assert.equal(graph.object, "fusion.graph");
    assert.ok(graph.nodes.length > 0);
  });
});

test("saveActiveGraph persists atomically and reads back, forcing id + updated_at", () => {
  withDataDir((dir) => {
    const seed = defaultGraph("2020-01-01T00:00:00.000Z");
    const saved = saveActiveGraph({ ...seed, id: "whatever", name: "fusion" });

    // The store normalizes the id and stamps a fresh updated_at.
    assert.equal(saved.id, "active");
    assert.notEqual(saved.updated_at, "2020-01-01T00:00:00.000Z");
    // Durable file written (and no leftover temp file from the atomic rename).
    assert.ok(existsSync(join(dir, "graph.json")));
    assert.ok(!existsSync(join(dir, "graph.json.tmp")));

    const reloaded = getActiveGraph();
    assert.deepEqual(reloaded.nodes, saved.nodes);
    assert.equal(reloaded.id, "active");
  });
});

test("getActiveGraph falls back to the seed when the file is corrupt", () => {
  withDataDir((dir) => {
    saveActiveGraph(defaultGraph("2020-01-01T00:00:00.000Z"));
    // Corrupt the persisted file; the store must not throw.
    writeFileSync(join(dir, "graph.json"), "{ not json");
    const graph = getActiveGraph();
    assert.equal(graph.object, "fusion.graph");
    assert.ok(graph.nodes.length > 0);
  });
});
