import assert from "node:assert/strict";
import test from "node:test";

import { modeFromModel } from "../src/lib/fusion/models.ts";

test("primary fusion/* aliases resolve", () => {
  assert.equal(modeFromModel("fusion/fast"), "fast");
  assert.equal(modeFromModel("fusion/fusion-3"), "fusion-3");
  assert.equal(modeFromModel("fusion/fusion-8"), "fusion-8");
});

test("nested fusion/fusion/* aliases still resolve for back-compat", () => {
  assert.equal(modeFromModel("fusion/fusion/fast"), "fast");
  assert.equal(modeFromModel("fusion/fusion/research"), "research");
  assert.equal(modeFromModel("fusion/fusion/fusion-3"), "fusion-3");
  assert.equal(modeFromModel("fusion/fusion/fusion-8"), "fusion-8");
});

test("openrouter/fusion and short aliases resolve", () => {
  assert.equal(modeFromModel("openrouter/fusion"), "openfusion");
  assert.equal(modeFromModel("fusion"), "openfusion");
  assert.equal(modeFromModel("fast"), "fast");
});
