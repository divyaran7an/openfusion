import assert from "node:assert/strict";
import test from "node:test";

import {
  getRunEvents,
  getThread,
  listThreads,
  listThreadRuns,
  saveRun,
  saveRunEvents
} from "../src/lib/fusion/store.ts";
import type { FusionRun, FusionRunEvent } from "../src/lib/fusion/types.ts";

function fixtureRun(input: {
  id: string;
  threadId: string;
  parentRunId?: string;
  turnIndex: number;
  createdAt: string;
}): FusionRun {
  return {
    id: input.id,
    object: "fusion.run",
    created_at: input.createdAt,
    completed_at: input.createdAt,
    mode: "fast",
    requested_model: "fast",
    status: "ok",
    degraded: false,
    prompt: `prompt ${input.turnIndex}`,
    final: `answer ${input.turnIndex}`,
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
      trace_id: `trc_${input.id}`,
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
      web_extract_available: false,
      thread_id: input.threadId,
      parent_run_id: input.parentRunId,
      turn_index: input.turnIndex
    }
  };
}

test("run events are stored and returned in sequence order", async () => {
  const runId = `run_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const events: FusionRunEvent[] = [
    {
      id: "evt_2",
      object: "fusion.run.event",
      run_id: runId,
      sequence: 2,
      type: "run.completed",
      created_at: "2026-06-23T00:00:02.000Z",
      data: { status: "ok" }
    },
    {
      id: "evt_0",
      object: "fusion.run.event",
      run_id: runId,
      sequence: 0,
      type: "run.started",
      created_at: "2026-06-23T00:00:00.000Z",
      data: { mode: "fast" }
    },
    {
      id: "evt_1",
      object: "fusion.run.event",
      run_id: runId,
      sequence: 1,
      type: "panel.started",
      created_at: "2026-06-23T00:00:01.000Z",
      data: { model: "deepseek/deepseek-v4-pro" }
    }
  ];

  await saveRunEvents(runId, events);
  const stored = await getRunEvents(runId);

  assert.deepEqual(
    stored.map((event) => event.sequence),
    [0, 1, 2]
  );
  assert.equal(stored[0]?.type, "run.started");
  assert.equal(stored[2]?.type, "run.completed");
});

test("runs are indexed by thread in turn order", async () => {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const threadId = `thr_${suffix}`;
  const first = fixtureRun({
    id: `run_first_${suffix}`,
    threadId,
    turnIndex: 0,
    createdAt: "2026-06-23T00:00:00.000Z"
  });
  const second = fixtureRun({
    id: `run_second_${suffix}`,
    threadId,
    parentRunId: first.id,
    turnIndex: 1,
    createdAt: "2026-06-23T00:00:01.000Z"
  });

  await saveRun(second);
  await saveRun(first);

  const threadRuns = await listThreadRuns(threadId);
  const thread = await getThread(threadId);
  const threads = await listThreads();

  assert.deepEqual(
    threadRuns.map((run) => run.id),
    [first.id, second.id]
  );
  assert.equal(threadRuns[1]?.metadata.parent_run_id, first.id);
  assert.equal(thread?.id, threadId);
  assert.equal(thread?.object, "fusion.thread");
  assert.equal(thread?.title, first.prompt);
  assert.equal(thread?.run_count, 2);
  assert.equal(thread?.first_run_id, first.id);
  assert.equal(thread?.latest_run_id, second.id);
  assert.equal(thread?.latest_prompt, second.prompt);
  assert.ok(threads.some((entry) => entry.id === threadId));
});
