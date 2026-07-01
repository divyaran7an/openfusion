import assert from "node:assert/strict";
import test from "node:test";

import {
  handleThreadGet,
  handleThreadsList
} from "../src/lib/fusion/thread-handlers.ts";
import type { FusionRun, FusionThread } from "../src/lib/fusion/types.ts";

const thread: FusionThread = {
  id: "thr_handler",
  object: "fusion.thread",
  title: "Review this release",
  created_at: "2026-06-23T00:00:00.000Z",
  updated_at: "2026-06-23T00:00:01.000Z",
  archived: false,
  run_count: 1,
  first_run_id: "run_handler",
  latest_run_id: "run_handler",
  latest_prompt: "Review this release",
  latest_mode: "fusion-3",
  latest_status: "ok",
  total_cost_usd: 0.001,
  total_latency_ms: 1000
};

const run = {
  id: "run_handler",
  object: "fusion.run",
  created_at: "2026-06-23T00:00:00.000Z",
  completed_at: "2026-06-23T00:00:01.000Z",
  mode: "fusion-3",
  requested_model: "fusion-3",
  status: "ok",
  degraded: false,
  prompt: "Review this release",
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
    end_to_end: 1000
  },
  cost_usd: 0.001,
  metadata: {
    trace_id: "trc_handler",
    panel_size: 3,
    panel_models: ["a", "b", "c"],
    judge_model: "judge",
    outer_model: "outer",
    runtime: "gateway",
    web_enabled: true,
    web_tools_available: false,
    web_fetch_available: false,
    local_tools_enabled: true,
    local_tools_available: false,
    judge_web_tools_available: false,
    outer_web_tools_available: false,
    web_extract_available: false,
    thread_id: "thr_handler",
    turn_index: 0
  }
} satisfies FusionRun;

test("thread handlers list and return thread details", async () => {
  const listResponse = await handleThreadsList(
    new Request("http://fusion.local/api/threads"),
    {
      listThreadRecords: async () => [thread]
    }
  );
  const listBody = await listResponse.json();

  assert.equal(listResponse.status, 200);
  assert.equal(listBody.object, "list");
  assert.equal(listBody.data[0].id, "thr_handler");

  const detailResponse = await handleThreadGet(
    new Request("http://fusion.local/api/threads/thr_handler"),
    "thr_handler",
    {
      getThreadRecord: async () => thread,
      listThreadRunRecords: async () => [run]
    }
  );
  const detailBody = await detailResponse.json();

  assert.equal(detailResponse.status, 200);
  assert.equal(detailBody.object, "fusion.thread.detail");
  assert.equal(detailBody.thread.id, "thr_handler");
  assert.equal(detailBody.runs[0].id, "run_handler");
});

test("thread detail handler returns not found for missing threads", async () => {
  const response = await handleThreadGet(
    new Request("http://fusion.local/api/threads/missing"),
    "missing",
    {
      getThreadRecord: async () => undefined
    }
  );
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error?.type, "not_found");
});
