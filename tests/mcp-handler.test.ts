import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { defaultGraph, graphToOverride } from "../src/lib/fusion/graph.ts";
import { saveActiveGraph } from "../src/lib/fusion/graph-store.ts";
import { handleMcpRequest, runDeepConsensus } from "../src/lib/fusion/mcp-handler.ts";
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
