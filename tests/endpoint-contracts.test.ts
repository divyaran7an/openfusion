import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { healthPayload, modelRecord, modelRecords } from "../src/lib/fusion/catalog.ts";
import { saveActiveGraph } from "../src/lib/fusion/graph-store.ts";
import {
  FusionHealthSchema,
  FusionModelRecordSchema,
  FusionModelsResponseSchema
} from "../src/lib/fusion/schemas.ts";
import type { FusionGraph } from "../src/lib/fusion/graph.ts";

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

function withSavedGraph<T>(graph: FusionGraph, run: () => T): T {
  const previous = process.env.FUSION_DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), "fusion-endpoint-contracts-"));
  process.env.FUSION_DATA_DIR = dir;
  try {
    saveActiveGraph(graph);
    return run();
  } finally {
    if (previous === undefined) delete process.env.FUSION_DATA_DIR;
    else process.env.FUSION_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("model catalog advertises the active graph plus callable aliases", () => {
  withDefaultGraph(() => {
    const catalog = modelRecords({ created: 1_782_000_000, webFetchAvailable: true });

    assert.deepEqual(FusionModelsResponseSchema.parse(catalog), catalog);
    assert.equal(catalog.object, "list");
    assert.ok(catalog.data.length > 1);

    const model = catalog.data[0];
    assert.equal(model?.id, "openfusion");
    assert.equal(model?.object, "model");
    assert.equal(model?.owned_by, "fusion");
    assert.equal(model?.fusion.mode, "openfusion");
    // Default seed council: three panels, a judge, and a synthesizer.
    assert.equal(model?.fusion.panel_size, 3);
    assert.equal(model?.fusion.panel_models.length, 3);
    assert.ok(model?.fusion.outer_model);
    assert.equal(model?.fusion.max_tool_calls, 8);
    assert.ok(model?.fusion.aliases.includes("fusion"));
    assert.ok(model?.fusion.aliases.includes("openrouter/fusion"));
    assert.ok(!model?.fusion.aliases.includes("fusion-8"));
    assert.ok(!model?.fusion.aliases.includes("fusion/fusion-8"));
    assert.ok(!model?.fusion.aliases.includes("fusion-3"));
    assert.ok(!model?.fusion.aliases.includes("fast"));
    assert.ok(!model?.fusion.aliases.includes("research"));
    assert.ok(catalog.data.some((entry) => entry.id === "fusion"));
    assert.ok(catalog.data.some((entry) => entry.id === "openrouter/fusion"));
    assert.ok(!catalog.data.some((entry) => entry.id === "fusion-8"));
    assert.ok(!catalog.data.some((entry) => entry.id === "fusion/fast"));
    assert.deepEqual(
      catalog.data.find((entry) => entry.id === "fusion")?.fusion.panel_models,
      model?.fusion.panel_models
    );
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

test("model catalog advertises role-default web settings for saved graphs", () => {
  withSavedGraph(
    {
      object: "fusion.graph",
      id: "active",
      name: "openfusion",
      max_tool_calls: 8,
      updated_at: "2026-07-01T00:00:00.000Z",
      nodes: [
        {
          id: "panel-1",
          role: "panel",
          source: "gateway",
          model: "openai/gpt-5.5",
          position: { x: 0, y: 0 }
        },
        {
          id: "judge-1",
          role: "judge",
          source: "gateway",
          model: "openai/gpt-5.5",
          position: { x: 200, y: 0 }
        },
        {
          id: "synth-1",
          role: "synthesizer",
          source: "gateway",
          model: "openai/gpt-5.5",
          position: { x: 400, y: 0 }
        }
      ]
    },
    () => {
      const catalog = modelRecords({ created: 1_782_000_000, webFetchAvailable: true });
      const model = catalog.data[0];

      assert.equal(model?.fusion.web_enabled, true);
      assert.equal(model?.fusion.web_fetch_enabled, true);
    }
  );
});

test("model retrieval accepts the caller's selected model slug", () => {
  withDefaultGraph(() => {
    const model = modelRecord("openrouter/fusion", {
      created: 1_782_000_000,
      webFetchAvailable: true
    });

    assert.deepEqual(FusionModelRecordSchema.parse(model), model);
    assert.equal(model.id, "openrouter/fusion");
    assert.equal(model.object, "model");
    assert.equal(model.owned_by, "fusion");
    assert.equal(model.fusion.panel_size, 3);
    assert.ok(model.fusion.aliases.includes("openrouter/fusion"));
  });
});

test("model catalog includes configured client aliases", () => {
  const previous = process.env.FUSION_MODEL_ALIASES;
  process.env.FUSION_MODEL_ALIASES = "gpt-4o=openfusion,cursor-default=fusion";
  try {
    withDefaultGraph(() => {
      const catalog = modelRecords({ created: 1_782_000_000, webFetchAvailable: true });
      assert.ok(catalog.data.some((model) => model.id === "gpt-4o"));
      assert.ok(catalog.data.some((model) => model.id === "cursor-default"));
    });
  } finally {
    if (previous === undefined) delete process.env.FUSION_MODEL_ALIASES;
    else process.env.FUSION_MODEL_ALIASES = previous;
  }
});

test("health contract reports readiness, endpoints, storage, and active models", () => {
  const health = withDefaultGraph(() =>
    healthPayload({
      gateway: true,
      gatewayWebSearch: true,
      openrouter: false,
      openrouterWebSearch: false,
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
  assert.equal(health.endpoints.responses, "/v1/responses");
  assert.equal(health.endpoints.run_stream, "/api/runs/stream");
  assert.equal(health.endpoints.run_events, "/api/runs/:id/events");
  assert.equal(health.models.find((model) => model.id === "openfusion")?.mode, "openfusion");
  assert.equal(health.models.find((model) => model.id === "openfusion")?.panel_size, 3);
});

test("health contract distinguishes missing gateway credentials", () => {
  const health = healthPayload({
    gateway: false,
    gatewayWebSearch: false,
    openrouter: false,
    openrouterWebSearch: false,
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

test("health readiness follows the active graph, not any available backend", () => {
  const health = withDefaultGraph(() =>
    healthPayload({
      gateway: false,
      gatewayReason: "No Vercel AI Gateway key set.",
      gatewayWebSearch: false,
      openrouter: false,
      openrouterWebSearch: false,
      webFetch: true,
      parallelExtract: false,
      localTools: true,
      harnesses: [
        {
          id: "codex",
          label: "Codex",
          kind: "local_harness",
          enabled: true,
          installed: true,
          command: "codex",
          command_path: "/usr/bin/codex",
          status: "ready",
          reason: "Connected.",
          timeout_ms: 600000,
          scratch_root: "/tmp/fusion-harness",
          supports: {
            sessions: false,
            approvals: false,
            events: true,
            shell: false,
            file_edit: false,
            browser: false
          }
        }
      ],
      store: "memory",
      authRequired: false
    })
  );

  assert.equal(health.status, "configuration_required");
  assert.equal(health.runtime.gateway, false);
  assert.equal(health.runtime.harnesses[0]?.status, "ready");
});
