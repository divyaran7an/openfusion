import assert from "node:assert/strict";
import test from "node:test";

import { healthPayload, modelRecords } from "../src/lib/fusion/catalog.ts";
import {
  FusionHealthSchema,
  FusionModelsResponseSchema
} from "../src/lib/fusion/schemas.ts";

// Point the graph store at an empty dir so getActiveGraph() returns the default
// seed graph (3 panels → judge → synth) deterministically, independent of any
// local .fusion/graph.json a developer may have saved.
function withDefaultGraph<T>(run: () => T): T {
  const previous = process.env.FUSION_DATA_DIR;
  process.env.FUSION_DATA_DIR = "/tmp/fusion-endpoint-contracts-empty";
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.FUSION_DATA_DIR;
    else process.env.FUSION_DATA_DIR = previous;
  }
}

test("model catalog advertises the active graph as a single OpenAI model", () => {
  withDefaultGraph(() => {
    const catalog = modelRecords({ created: 1_782_000_000, webFetchAvailable: true });

    assert.deepEqual(FusionModelsResponseSchema.parse(catalog), catalog);
    assert.equal(catalog.object, "list");
    assert.equal(catalog.data.length, 1);

    const model = catalog.data[0];
    assert.equal(model?.id, "openfusion");
    assert.equal(model?.object, "model");
    assert.equal(model?.owned_by, "fusion");
    // Default seed council: three panels, a judge, and a synthesizer.
    assert.equal(model?.fusion.panel_size, 3);
    assert.equal(model?.fusion.panel_models.length, 3);
    assert.ok(model?.fusion.outer_model);
    assert.equal(model?.fusion.max_tool_calls, 8);
    assert.ok(model?.fusion.aliases.includes("fusion"));
    assert.ok(model?.fusion.aliases.includes("openrouter/fusion"));
  });
});

test("model catalog reflects webFetch availability without changing routing", () => {
  withDefaultGraph(() => {
    const enabled = modelRecords({ created: 1_782_000_000, webFetchAvailable: true });
    const disabled = modelRecords({ created: 1_782_000_000, webFetchAvailable: false });

    assert.equal(enabled.data[0]?.fusion.web_fetch_enabled, true);
    assert.equal(disabled.data[0]?.fusion.web_fetch_enabled, false);
    assert.deepEqual(
      enabled.data.map((model) => model.fusion.panel_models),
      disabled.data.map((model) => model.fusion.panel_models)
    );
  });
});

test("health contract reports readiness, endpoints, storage, and active models", () => {
  const health = withDefaultGraph(() =>
    healthPayload({
      gateway: true,
      gatewayWebSearch: true,
      webFetch: true,
      parallelExtract: false,
      localTools: true,
      harnesses: [],
      store: "memory",
      authRequired: false
    })
  );

  assert.deepEqual(FusionHealthSchema.parse(health), health);
  assert.equal(health.object, "fusion.health");
  assert.equal(health.status, "ready");
  assert.equal(health.runtime.store, "memory");
  assert.deepEqual(health.runtime.harnesses, []);
  assert.equal(health.endpoints.threads, "/api/threads");
  assert.equal(health.endpoints.chat_completions, "/v1/chat/completions");
  assert.equal(health.endpoints.run_stream, "/api/runs/stream");
  assert.equal(health.endpoints.run_events, "/api/runs/:id/events");
  assert.equal(health.models.find((model) => model.id === "openfusion")?.panel_size, 3);
});

test("health contract distinguishes missing gateway credentials", () => {
  const health = healthPayload({
    gateway: false,
    gatewayWebSearch: false,
    webFetch: true,
    parallelExtract: false,
    localTools: true,
    harnesses: [],
    store: "redis",
    authRequired: true
  });

  assert.equal(health.status, "configuration_required");
  assert.equal(health.runtime.auth_required, true);
  assert.equal(health.runtime.store, "redis");
});
