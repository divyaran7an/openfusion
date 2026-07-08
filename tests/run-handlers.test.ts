import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { FusionConfigurationError } from "../src/lib/fusion/errors.ts";
import { defaultGraph, graphToOverride } from "../src/lib/fusion/graph.ts";
import { saveActiveGraph } from "../src/lib/fusion/graph-store.ts";
import {
  completeRunEvents,
  publishRunEvent
} from "../src/lib/fusion/run-event-bus.ts";
import {
  handleRunCreate,
  handleRunEventsGet,
  handleRunGet,
  handleRunsList
} from "../src/lib/fusion/run-handlers.ts";
import type { FusionRun, FusionRunEvent } from "../src/lib/fusion/types.ts";

function fixtureRun(input: Partial<FusionRun> = {}): FusionRun {
  return {
    id: "run_test",
    object: "fusion.run",
    created_at: "2026-06-23T00:00:00.000Z",
    completed_at: "2026-06-23T00:00:01.000Z",
    mode: "fast",
    requested_model: "fast",
    status: "ok",
    degraded: false,
    prompt: "ok",
    final: "ok",
    responses: [],
    failed_models: [],
    sources: [],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2
    },
    latency_ms: {
      panel_max: 1,
      judge: 0,
      synthesis: 0,
      end_to_end: 1
    },
    cost_usd: 0,
    metadata: {
      trace_id: "trc_test",
      panel_size: 1,
      panel_models: ["test/model"],
      judge_model: "test/judge",
      outer_model: "test/outer",
      runtime: "gateway",
      web_enabled: true,
      web_tools_available: false,
      web_fetch_available: false,
      local_tools_enabled: true,
      local_tools_available: false,
      judge_web_tools_available: false,
      outer_web_tools_available: false,
      web_extract_available: false
    },
    ...input
  };
}

function fixtureEvent(input: Partial<FusionRunEvent> = {}): FusionRunEvent {
  return {
    id: "evt_test",
    object: "fusion.run.event",
    run_id: "run_test",
    sequence: 1,
    type: "run.started",
    created_at: "2026-06-23T00:00:00.000Z",
    data: {
      mode: "fast"
    },
    ...input
  };
}

test("native run handlers enforce API auth before storage or model work", async () => {
  const previous = process.env.FUSION_API_KEYS;
  process.env.FUSION_API_KEYS = "secret";
  let listed = false;

  try {
    const response = await handleRunsList(
      new Request("http://fusion.local/api/runs"),
      {
        listRunRecords: async () => {
          listed = true;
          return [];
        }
      }
    );
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.equal(body.error?.type, "unauthorized");
    assert.equal(listed, false);
  } finally {
    if (previous === undefined) {
      delete process.env.FUSION_API_KEYS;
    } else {
      process.env.FUSION_API_KEYS = previous;
    }
  }
});

test("native run create validates input, saves the run, and persists emitted events", async () => {
  const event = fixtureEvent();
  let savedRun: FusionRun | undefined;
  let savedEvents: FusionRunEvent[] | undefined;

  const response = await handleRunCreate(
    new Request("http://fusion.local/api/runs", {
      method: "POST",
      body: JSON.stringify({
        model: "fast",
        prompt: "ok"
      })
    }),
    {
      runner: async (input, options) => {
        assert.equal(input.prompt, "ok");
        await options.onEvent?.(event);
        return fixtureRun();
      },
      saveRunRecord: async (run) => {
        savedRun = run;
        return run;
      },
      saveEvents: async (_runId, events) => {
        savedEvents = events;
        return events;
      }
    }
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.id, "run_test");
  assert.equal(savedRun?.id, "run_test");
  assert.deepEqual(savedEvents, [event]);
});

async function withDataDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const previous = process.env.FUSION_DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), "fusion-run-handlers-"));
  process.env.FUSION_DATA_DIR = dir;
  try {
    return await run(dir);
  } finally {
    if (previous === undefined) delete process.env.FUSION_DATA_DIR;
    else process.env.FUSION_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("native run create runs the active graph, matching /v1/*", async () => {
  await withDataDir(async () => {
    const graph = saveActiveGraph(defaultGraph("2026-01-01T00:00:00.000Z"));
    const expected = graphToOverride(graph);
    let received: unknown;

    const response = await handleRunCreate(
      new Request("http://fusion.local/api/runs", {
        method: "POST",
        body: JSON.stringify({ prompt: "ok" })
      }),
      {
        runner: async (input) => {
          received = input.fusion;
          assert.equal(input.prompt, "ok");
          return fixtureRun();
        },
        saveRunRecord: async (run) => run,
        saveEvents: async (_runId, events) => events
      }
    );

    assert.equal(response.status, 200);
    assert.deepEqual(received, expected);
  });
});

test("native run create fails loudly when the active graph is not runnable", async () => {
  await withDataDir(async () => {
    const seed = defaultGraph("2026-01-01T00:00:00.000Z");
    // Schema-valid but rule-invalid: no synthesizer to write the final answer.
    saveActiveGraph({
      ...seed,
      nodes: seed.nodes.filter((node) => node.role !== "synthesizer")
    });
    let ran = false;

    const response = await handleRunCreate(
      new Request("http://fusion.local/api/runs", {
        method: "POST",
        body: JSON.stringify({ prompt: "ok" })
      }),
      {
        runner: async () => {
          ran = true;
          return fixtureRun();
        }
      }
    );
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.error?.type, "configuration_required");
    assert.match(body.error?.message ?? "", /isn't runnable yet/);
    assert.equal(ran, false);
  });
});

test("native run create keeps an explicit fusion override over the graph", async () => {
  await withDataDir(async () => {
    saveActiveGraph(defaultGraph("2026-01-01T00:00:00.000Z"));
    let received: { panel_models?: string[]; outer_model?: string } | undefined;

    const response = await handleRunCreate(
      new Request("http://fusion.local/api/runs", {
        method: "POST",
        body: JSON.stringify({
          prompt: "ok",
          fusion: {
            panel_models: ["custom/panel"],
            outer_model: "custom/synth"
          }
        })
      }),
      {
        runner: async (input) => {
          received = input.fusion ?? undefined;
          return fixtureRun();
        },
        saveRunRecord: async (run) => run,
        saveEvents: async (_runId, events) => events
      }
    );

    assert.equal(response.status, 200);
    assert.deepEqual(received?.panel_models, ["custom/panel"]);
    assert.equal(received?.outer_model, "custom/synth");
  });
});

test("native run list filters by thread id when requested", async () => {
  let requestedThreadId = "";
  const response = await handleRunsList(
    new Request("http://fusion.local/api/runs?thread_id=thr_test"),
    {
      listRunRecords: async () => {
        throw new Error("Should not call global run list for a thread query.");
      },
      listThreadRunRecords: async (threadId) => {
        requestedThreadId = threadId;
        return [
          fixtureRun({
            metadata: {
              ...fixtureRun().metadata,
              thread_id: threadId,
              turn_index: 0
            }
          })
        ];
      }
    }
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(requestedThreadId, "thr_test");
  assert.equal(body.thread_id, "thr_test");
  assert.equal(body.data[0].metadata.thread_id, "thr_test");
});

test("native run create reports validation and configuration failures distinctly", async () => {
  const malformed = await handleRunCreate(
    new Request("http://fusion.local/api/runs", {
      method: "POST",
      body: JSON.stringify({
        messages: []
      })
    }),
    {
      runner: async () => fixtureRun()
    }
  );
  const malformedBody = await malformed.json();

  assert.equal(malformed.status, 400);
  assert.equal(malformedBody.error?.type, "bad_request");

  const missingConfig = await handleRunCreate(
    new Request("http://fusion.local/api/runs", {
      method: "POST",
      body: JSON.stringify({
        prompt: "ok"
      })
    }),
    {
      runner: async () => {
        throw new FusionConfigurationError("Set AI_GATEWAY_API_KEY.");
      }
    }
  );
  const missingConfigBody = await missingConfig.json();

  assert.equal(missingConfig.status, 503);
  assert.equal(missingConfigBody.error?.type, "configuration_required");
});

test("native run read and event handlers return not found for unknown runs", async () => {
  const runResponse = await handleRunGet(
    new Request("http://fusion.local/api/runs/run_missing"),
    "run_missing",
    {
      getRunRecord: async () => undefined
    }
  );
  const eventResponse = await handleRunEventsGet(
    new Request("http://fusion.local/api/runs/run_missing/events"),
    "run_missing",
    {
      getRunRecord: async () => undefined
    }
  );

  assert.equal(runResponse.status, 404);
  assert.equal((await runResponse.json()).error?.type, "not_found");
  assert.equal(eventResponse.status, 404);
  assert.equal((await eventResponse.json()).error?.type, "not_found");
});

test("native run event handler returns JSON lists and SSE replay", async () => {
  const event = fixtureEvent();
  const deps = {
    getRunRecord: async () => fixtureRun(),
    getEventRecords: async () => [event]
  };
  const listResponse = await handleRunEventsGet(
    new Request("http://fusion.local/api/runs/run_test/events"),
    "run_test",
    deps
  );
  const listBody = await listResponse.json();

  assert.equal(listResponse.status, 200);
  assert.equal(listBody.object, "list");
  assert.equal(listBody.run_id, "run_test");
  assert.equal(listBody.data[0].id, "evt_test");

  const streamResponse = await handleRunEventsGet(
    new Request("http://fusion.local/api/runs/run_test/events?stream=1"),
    "run_test",
    deps
  );
  const text = await streamResponse.text();

  assert.equal(streamResponse.status, 200);
  assert.match(streamResponse.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.match(text, /event: run\.started/);
  assert.match(text, /data: \{"id":"evt_test"/);
  assert.match(text, /event: done/);
});

test("native run event handler can attach to active unsaved run streams", async () => {
  const runId = `run_active_${crypto.randomUUID().replaceAll("-", "")}`;
  const first = fixtureEvent({
    id: `${runId}_evt_0`,
    run_id: runId,
    sequence: 0,
    type: "run.started"
  });
  const second = fixtureEvent({
    id: `${runId}_evt_1`,
    run_id: runId,
    sequence: 1,
    type: "panel.started",
    data: {
      model: "test/model"
    }
  });

  publishRunEvent(first);

  const response = await handleRunEventsGet(
    new Request(`http://fusion.local/api/runs/${runId}/events?stream=1`),
    runId,
    {
      getRunRecord: async () => {
        throw new Error("Active streams should not require a saved run.");
      }
    }
  );
  const textPromise = response.text();

  queueMicrotask(() => {
    publishRunEvent(second);
    completeRunEvents(runId);
  });

  const text = await textPromise;

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.match(text, /event: run\.started/);
  assert.match(text, /event: panel\.started/);
  assert.match(text, /event: done/);

  const resumed = await handleRunEventsGet(
    new Request(`http://fusion.local/api/runs/${runId}/events?stream=1&after=0`),
    runId,
    {
      getRunRecord: async () => {
        throw new Error("Completed active streams should replay from memory briefly.");
      }
    }
  );
  const resumedText = await resumed.text();

  assert.doesNotMatch(resumedText, /event: run\.started/);
  assert.match(resumedText, /event: panel\.started/);
  assert.match(resumedText, /event: done/);
});
