import { test } from "node:test";
import assert from "node:assert/strict";

import { rankRuns, type CouncilRun, type CompareTarget } from "../src/lib/fusion/compare.ts";

type RunInput = {
  councilId: string;
  councilName: string;
  isTeacher?: boolean;
  overall?: number; // LLM score 0-100
  cost?: number; // dollars; undefined = unknown
  latencyMs?: number; // undefined = unknown
};

function run(input: RunInput): CouncilRun {
  return {
    councilId: input.councilId,
    councilName: input.councilName,
    isTeacher: input.isTeacher ?? false,
    score: { overall: input.overall, rationale: "" },
    metrics: {
      latencyMs: input.latencyMs,
      cost: input.cost,
      tokens: 0
    }
  };
}

function top(runs: CouncilRun[], target: CompareTarget): CouncilRun {
  const ranked = rankRuns(runs, target);
  assert.ok(ranked.length > 0, "rankRuns should return at least one run");
  return ranked[0];
}

test("Quality target ranks by highest overall LLM score", () => {
  const winner = top(
    [
      run({ councilId: "a", councilName: "A", overall: 78 }),
      run({ councilId: "b", councilName: "B", overall: 91 }),
      run({ councilId: "c", councilName: "C", overall: 85 })
    ],
    "quality"
  );
  assert.equal(winner.councilId, "b");
});

test("Value target ranks by score per dollar, highest wins", () => {
  // A: 89 / $0.014 = 6357 ; B: 78 / $0.003 = 26000 -> B wins on value
  const winner = top(
    [
      run({ councilId: "budget", councilName: "Budget", overall: 89, cost: 0.014 }),
      run({ councilId: "fast", councilName: "Fast", overall: 78, cost: 0.003 })
    ],
    "value"
  );
  assert.equal(winner.councilId, "fast");
});

test("Speed target ranks by score per latency, highest wins", () => {
  // A: 89 / 11.8s = 7.54 ; B: 78 / 3.9s = 20.0 -> B wins on speed
  const winner = top(
    [
      run({ councilId: "budget", councilName: "Budget", overall: 89, latencyMs: 11800 }),
      run({ councilId: "fast", councilName: "Fast", overall: 78, latencyMs: 3900 })
    ],
    "speed"
  );
  assert.equal(winner.councilId, "fast");
});

test("unknown cost is excluded from Value ranking, not treated as zero", () => {
  // Teacher has unknown cost. Under value, a free/unknown cost must NOT become
  // infinite score-per-dollar. The ranked candidate must win, and the teacher
  // is excluded from value/speed ranking entirely.
  const ranked = rankRuns(
    [
      run({ councilId: "teacher", councilName: "Teacher", isTeacher: true, overall: 94 }),
      run({ councilId: "budget", councilName: "Budget", overall: 89, cost: 0.014 })
    ],
    "value"
  );
  assert.equal(ranked[0].councilId, "budget");
  assert.ok(!ranked.some((r) => r.councilId === "teacher"), "teacher must be excluded from ranking");
});

test("unknown latency is excluded from Speed ranking, not treated as zero", () => {
  const ranked = rankRuns(
    [
      run({ councilId: "teacher", councilName: "Teacher", isTeacher: true, overall: 94 }),
      run({ councilId: "fast", councilName: "Fast", overall: 78, latencyMs: 3900 })
    ],
    "speed"
  );
  assert.equal(ranked[0].councilId, "fast");
});

test("teacher column is never returned as the recommended winner under any target", () => {
  for (const target of ["quality", "value", "speed"] as CompareTarget[]) {
    const ranked = rankRuns(
      [
        run({ councilId: "teacher", councilName: "Teacher", isTeacher: true, overall: 99, cost: 0.001, latencyMs: 100 }),
        run({ councilId: "cand", councilName: "Cand", overall: 70, cost: 0.5, latencyMs: 60000 })
      ],
      target
    );
    assert.notEqual(ranked[0].councilId, "teacher", `teacher must not win under ${target}`);
  }
});

test("rankRuns returns candidates only, with the teacher filtered out", () => {
  const ranked = rankRuns(
    [
      run({ councilId: "teacher", councilName: "Teacher", isTeacher: true, overall: 94 }),
      run({ councilId: "a", councilName: "A", overall: 80 }),
      run({ councilId: "b", councilName: "B", overall: 82 })
    ],
    "quality"
  );
  assert.equal(ranked.length, 2, "teacher is a reference, not a ranked candidate");
  assert.deepEqual(
    ranked.map((r) => r.councilId),
    ["b", "a"]
  );
});

test("ties break deterministically by council id so the UI badge is stable", () => {
  const ranked = rankRuns(
    [
      run({ councilId: "zeta", councilName: "Z", overall: 85 }),
      run({ councilId: "alpha", councilName: "A", overall: 85 })
    ],
    "quality"
  );
  assert.equal(ranked[0].councilId, "alpha", "deterministic tie-break keeps the UI stable across renders");
});

test("runs missing an overall score sort last under every target", () => {
  const ranked = rankRuns(
    [
      run({ councilId: "unscored", councilName: "U" }), // overall undefined
      run({ councilId: "scored", councilName: "S", overall: 60, cost: 0.01, latencyMs: 1000 })
    ],
    "quality"
  );
  assert.equal(ranked[0].councilId, "scored");
  assert.equal(ranked[ranked.length - 1].councilId, "unscored");
});

test("Value target excludes all candidates with unknown cost, not just some", () => {
  // If every candidate has unknown cost, value ranking falls back to quality
  // order so the Recommended badge is never empty/arbitrary.
  const ranked = rankRuns(
    [
      run({ councilId: "a", councilName: "A", overall: 80 }),
      run({ councilId: "b", councilName: "B", overall: 90 })
    ],
    "value"
  );
  assert.equal(ranked[0].councilId, "b", "falls back to quality when no cost data exists");
});

test("empty input returns an empty ranking instead of throwing", () => {
  assert.deepEqual(rankRuns([], "quality"), []);
});
