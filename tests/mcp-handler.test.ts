import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { defaultGraph, graphToOverride } from "../src/lib/fusion/graph.ts";
import { saveActiveGraph } from "../src/lib/fusion/graph-store.ts";
import {
  DEEP_CONSENSUS_INPUT_SHAPE,
  DEEP_CONSENSUS_OUTPUT_SHAPE,
  handleMcpRequest,
  runDeepConsensus
} from "../src/lib/fusion/mcp-handler.ts";
import type { FusionRun, FusionRunEvent } from "../src/lib/fusion/types.ts";

async function withDataDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const previous = process.env.FUSION_DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), "fusion-mcp-"));
  process.env.FUSION_DATA_DIR = dir;
  try {
    return await run(dir);
  } finally {
    if (previous === undefined) delete process.env.FUSION_DATA_DIR;
    else process.env.FUSION_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

function fixtureRun(input: Partial<FusionRun> = {}): FusionRun {
  return {
    id: "run_mcp",
    object: "fusion.run",
    created_at: "2026-07-08T00:00:00.000Z",
    completed_at: "2026-07-08T00:00:05.000Z",
    mode: "openfusion",
    requested_model: "openfusion",
    status: "ok",
    degraded: false,
    prompt: "what is the answer",
    final: "the synthesized answer",
    responses: [],
    failed_models: [],
    sources: [],
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    latency_ms: { panel_max: 100, judge: 50, synthesis: 80, end_to_end: 250 },
    cost_usd: 0.009,
    metadata: {
      trace_id: "trc_mcp",
      panel_size: 3,
      panel_models: ["openai/gpt-5.5", "claude-code/sonnet", "openrouter/deepseek/deepseek-v4-pro"],
      judge_model: "claude-code/opus",
      outer_model: "claude-code/opus",
      runtime: "mixed",
      web_enabled: true,
      web_tools_available: false,
      web_fetch_available: false,
      local_tools_enabled: false,
      local_tools_available: false,
      judge_web_tools_available: false,
      outer_web_tools_available: false,
      web_extract_available: false,
      cost_source: "provider_reported"
    },
    ...input
  };
}

function fixtureEvent(input: Partial<FusionRunEvent> = {}): FusionRunEvent {
  return {
    id: "evt_mcp",
    object: "fusion.run.event",
    run_id: "run_mcp",
    sequence: 1,
    type: "run.started",
    created_at: "2026-07-08T00:00:00.000Z",
    data: { mode: "openfusion" },
    ...input
  };
}

test("runDeepConsensus runs the active graph and returns text plus structured metadata", async () => {
  await withDataDir(async () => {
    const graph = saveActiveGraph(defaultGraph("2026-01-01T00:00:00.000Z"));
    const expected = graphToOverride(graph);
    const progress: Array<{ progress: number; message: string }> = [];
    let savedRun: FusionRun | undefined;
    let savedEvents: FusionRunEvent[] | undefined;

    const result = await runDeepConsensus(
      { question: "what is the answer", system_prompt: "be terse" },
      {
        runner: async (input, options) => {
          assert.deepEqual(input.fusion, expected);
          assert.equal(input.messages?.[0]?.role, "system");
          assert.equal(input.messages?.[0]?.content, "be terse");
          assert.equal(input.messages?.[1]?.role, "user");
          assert.equal(input.messages?.[1]?.content, "what is the answer");
          await options.onEvent?.(fixtureEvent());
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
      },
      {
        notify: async (value, message) => {
          progress.push({ progress: value, message });
        }
      }
    );

    assert.equal(result.isError, false);
    assert.equal(result.text, "the synthesized answer");
    assert.equal(result.structured?.run_id, "run_mcp");
    assert.equal(result.structured?.panel_size, 3);
    assert.equal(result.structured?.judge_model, "claude-code/opus");
    assert.equal(result.structured?.cost_usd, 0.009);
    assert.equal(result.structured?.cost_source, "provider_reported");
    assert.equal(savedRun?.id, "run_mcp");
    assert.equal(savedEvents?.length, 1);
    assert.deepEqual(progress, [{ progress: 1, message: "run.started" }]);
  });
});

test("runDeepConsensus mints a thread on first call and replays it on follow-ups", async () => {
  await withDataDir(async () => {
    saveActiveGraph(defaultGraph("2026-01-01T00:00:00.000Z"));

    // First call: no thread_id in, a fresh one out, turn 0, no context.
    const first = await runDeepConsensus(
      { question: "pick a database" },
      {
        runner: async (input) => {
          assert.equal(input.context_messages, undefined);
          assert.equal(input.turn_index, 0);
          assert.ok(input.thread_id?.startsWith("thr"));
          return fixtureRun({
            id: "run_turn_0",
            prompt: "pick a database",
            final: "Use Postgres.",
            metadata: { ...fixtureRun().metadata, thread_id: input.thread_id, turn_index: 0 }
          });
        },
        saveRunRecord: async (run) => run,
        saveEvents: async (_runId, events) => events
      }
    );
    assert.equal(first.isError, false);
    const threadId = first.structured?.thread_id;
    assert.ok(threadId);
    assert.equal(first.structured?.turn_index, 0);

    // Follow-up: earlier turns arrive as conversation context, turn increments,
    // parent run is the previous turn.
    const priorRun = fixtureRun({
      id: "run_turn_0",
      prompt: "pick a database",
      final: "Use Postgres.",
      metadata: { ...fixtureRun().metadata, thread_id: threadId, turn_index: 0 }
    });
    const second = await runDeepConsensus(
      { question: "why not MySQL?", thread_id: threadId },
      {
        listThreadRunRecords: async (requested) => {
          assert.equal(requested, threadId);
          return [priorRun];
        },
        runner: async (input) => {
          assert.deepEqual(input.context_messages, [
            { role: "user", content: "pick a database" },
            { role: "assistant", content: "Use Postgres." }
          ]);
          assert.equal(input.thread_id, threadId);
          assert.equal(input.parent_run_id, "run_turn_0");
          assert.equal(input.turn_index, 1);
          assert.equal(input.messages?.at(-1)?.content, "why not MySQL?");
          return fixtureRun({
            id: "run_turn_1",
            metadata: { ...fixtureRun().metadata, thread_id: threadId, turn_index: 1 }
          });
        },
        saveRunRecord: async (run) => run,
        saveEvents: async (_runId, events) => events
      }
    );
    assert.equal(second.isError, false);
    assert.equal(second.structured?.thread_id, threadId);
    assert.equal(second.structured?.turn_index, 1);
  });
});

test("deep_consensus output contract is additive-only (schema freeze)", () => {
  // Fields may be ADDED to these lists; never renamed, removed, or repurposed.
  // If this test fails on a removal or rename, that's a breaking change for
  // every agent built against the tool — don't.
  assert.deepEqual(Object.keys(DEEP_CONSENSUS_INPUT_SHAPE).sort(), [
    "question",
    "system_prompt",
    "thread_id"
  ]);
  assert.deepEqual(Object.keys(DEEP_CONSENSUS_OUTPUT_SHAPE).sort(), [
    "cost_source",
    "cost_usd",
    "degraded",
    "judge_model",
    "latency_ms_end_to_end",
    "outer_model",
    "panel_models",
    "panel_size",
    "run_id",
    "status",
    "thread_id",
    "turn_index"
  ]);
});

test("deep_consensus advertises an OPEN output schema on the wire", async () => {
  // The MCP spec tells clients to validate structured results against the
  // declared output schema. A closed schema (additionalProperties: false)
  // would make every additive field a breaking change for clients holding a
  // pre-upgrade schema — the contract is additive-only, so the schema must
  // stay open.
  const response = await handleMcpRequest(
    new Request("http://fusion.local/api/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    })
  );

  assert.equal(response.status, 200);
  const dataLine = (await response.text()).split("\n").find((line) => line.startsWith("data:"));
  assert.ok(dataLine);
  const tool = JSON.parse(dataLine.slice("data:".length).trim()).result.tools[0];
  assert.equal(tool.name, "deep_consensus");
  assert.notEqual(tool.outputSchema.additionalProperties, false);
});

test("runDeepConsensus marks an error run as an in-band tool error", async () => {
  await withDataDir(async () => {
    saveActiveGraph(defaultGraph("2026-01-01T00:00:00.000Z"));
    const result = await runDeepConsensus(
      { question: "doomed" },
      {
        runner: async () =>
          fixtureRun({
            status: "error",
            failure_reason: "all_panels_failed",
            final: "Every panel model failed."
          }),
        saveRunRecord: async (run) => run,
        saveEvents: async (_runId, events) => events
      }
    );

    assert.equal(result.isError, true);
    assert.match(result.text, /failed/i);
    assert.equal(result.structured?.status, "error");
  });
});

test("runDeepConsensus fails in-band when the active graph is not runnable", async () => {
  await withDataDir(async () => {
    const seed = defaultGraph("2026-01-01T00:00:00.000Z");
    saveActiveGraph({
      ...seed,
      nodes: seed.nodes.filter((node) => node.role !== "synthesizer")
    });
    let ran = false;

    const result = await runDeepConsensus(
      { question: "anything" },
      {
        runner: async () => {
          ran = true;
          return fixtureRun();
        }
      }
    );

    assert.equal(ran, false);
    assert.equal(result.isError, true);
    assert.match(result.text, /isn't runnable yet/);
  });
});

test("MCP endpoint answers an initialize round trip", async () => {
  await withDataDir(async () => {
    saveActiveGraph(defaultGraph("2026-01-01T00:00:00.000Z"));
    const response = await handleMcpRequest(
      new Request("http://fusion.local/api/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0.0" }
          }
        })
      })
    );

    assert.equal(response.status, 200);
    const text = await response.text();
    const dataLine = text
      .split("\n")
      .find((line) => line.startsWith("data:"));
    assert.ok(dataLine, `expected an SSE data line, got: ${text.slice(0, 200)}`);
    const payload = JSON.parse(dataLine.slice("data:".length).trim());
    assert.equal(payload.result?.serverInfo?.name, "openfusion");
    assert.ok(payload.result?.capabilities?.tools);
  });
});

test("MCP endpoint rejects non-POST methods and enforces API auth", async () => {
  const getResponse = await handleMcpRequest(
    new Request("http://fusion.local/api/mcp", { method: "GET" })
  );
  assert.equal(getResponse.status, 405);
  assert.equal(getResponse.headers.get("allow"), "POST");

  const previous = process.env.FUSION_API_KEYS;
  process.env.FUSION_API_KEYS = "secret";
  try {
    const unauthorized = await handleMcpRequest(
      new Request("http://fusion.local/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })
      })
    );
    assert.equal(unauthorized.status, 401);
  } finally {
    if (previous === undefined) delete process.env.FUSION_API_KEYS;
    else process.env.FUSION_API_KEYS = previous;
  }
});
