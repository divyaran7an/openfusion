import assert from "node:assert/strict";
import test from "node:test";

import {
  harnessForModel,
  isHarnessModel,
  requiredBackends,
  resolveModelTarget,
  runtimeLabel
} from "../src/lib/fusion/model-routing.ts";

test("resolveModelTarget routes harness-namespaced ids to their harness", () => {
  assert.deepEqual(resolveModelTarget("claude-code/opus"), {
    kind: "harness",
    harness: "claude-code",
    model: "opus"
  });
  assert.deepEqual(resolveModelTarget("codex/gpt-5.5-codex"), {
    kind: "harness",
    harness: "codex",
    model: "gpt-5.5-codex"
  });
});

test("resolveModelTarget routes OpenRouter-namespaced ids to OpenRouter", () => {
  assert.deepEqual(resolveModelTarget("openrouter/anthropic/claude-opus-4.8"), {
    kind: "openrouter",
    model: "anthropic/claude-opus-4.8"
  });
  assert.deepEqual(resolveModelTarget("openrouter/openrouter/auto"), {
    kind: "openrouter",
    model: "openrouter/auto"
  });
});

test("resolveModelTarget routes bare ids to the gateway", () => {
  assert.deepEqual(resolveModelTarget("anthropic/claude-opus-4.8"), {
    kind: "gateway",
    model: "anthropic/claude-opus-4.8"
  });
  assert.equal(resolveModelTarget("gpt-5.5").kind, "gateway");
  // A harness prefix with no sub-model is not a valid harness target.
  assert.equal(resolveModelTarget("codex/").kind, "gateway");
});

test("isHarnessModel / harnessForModel agree with routing", () => {
  assert.equal(isHarnessModel("codex/gpt-5.5-codex"), true);
  assert.equal(isHarnessModel("openai/gpt-5.5"), false);
  assert.equal(harnessForModel("claude-code/sonnet"), "claude-code");
  assert.equal(harnessForModel("openai/gpt-5.5"), undefined);
});

test("requiredBackends reports the union of backends a model set needs", () => {
  const mixed = requiredBackends([
    "zai/glm-5.2",
    "openrouter/anthropic/claude-opus-4.8",
    "claude-code/opus",
    "codex/gpt-5.5-codex",
    undefined
  ]);
  assert.equal(mixed.gateway, true);
  assert.equal(mixed.openrouter, true);
  assert.deepEqual([...mixed.harnesses].sort(), ["claude-code", "codex"]);

  const harnessOnly = requiredBackends(["claude-code/opus", "codex/x"]);
  assert.equal(harnessOnly.gateway, false);
  assert.equal(harnessOnly.openrouter, false);
  assert.equal(harnessOnly.harnesses.length, 2);

  const openRouterOnly = requiredBackends(["openrouter/openai/gpt-5.5"]);
  assert.equal(openRouterOnly.gateway, false);
  assert.equal(openRouterOnly.openrouter, true);
  assert.equal(openRouterOnly.harnesses.length, 0);

  const gatewayOnly = requiredBackends(["openai/gpt-5.5", "anthropic/claude-opus-4.8"]);
  assert.equal(gatewayOnly.gateway, true);
  assert.equal(gatewayOnly.openrouter, false);
  assert.equal(gatewayOnly.harnesses.length, 0);
});

test("runtimeLabel reflects gateway / OpenRouter / harness / mixed honestly", () => {
  assert.equal(runtimeLabel(["openai/gpt-5.5"]), "gateway");
  assert.equal(runtimeLabel(["openrouter/openai/gpt-5.5"]), "openrouter");
  assert.equal(runtimeLabel(["claude-code/opus", "codex/x"]), "harness");
  assert.equal(runtimeLabel(["openai/gpt-5.5", "claude-code/opus"]), "mixed");
  assert.equal(runtimeLabel(["openrouter/openai/gpt-5.5", "claude-code/opus"]), "mixed");
});
