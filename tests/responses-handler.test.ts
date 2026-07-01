import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { handleOpenAIResponse } from "../src/lib/fusion/responses-handler.ts";
import { OpenAIResponseObjectSchema } from "../src/lib/fusion/schemas.ts";
import type { FusionRun, FusionRunEvent } from "../src/lib/fusion/types.ts";

const previousFusionDataDir = process.env.FUSION_DATA_DIR;
const testFusionDataDir = mkdtempSync(join(tmpdir(), "openfusion-responses-handler-"));
process.env.FUSION_DATA_DIR = testFusionDataDir;

after(() => {
  if (previousFusionDataDir === undefined) {
    delete process.env.FUSION_DATA_DIR;
  } else {
    process.env.FUSION_DATA_DIR = previousFusionDataDir;
  }
  rmSync(testFusionDataDir, { recursive: true, force: true });
});

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1:3000/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

function fixtureRun(input: Partial<FusionRun> = {}): FusionRun {
  return {
    id: "run_responses",
    object: "fusion.run",
    created_at: "2026-07-01T00:00:00.000Z",
    completed_at: "2026-07-01T00:00:01.000Z",
    mode: "fusion-3",
    requested_model: "openfusion",
    status: "ok",
    degraded: false,
    prompt: "Reply with exactly ok.",
    final: "ok",
    responses: [],
    failed_models: [],
    sources: [],
    usage: {
      input_tokens: 3,
      output_tokens: 1,
      total_tokens: 4
    },
    latency_ms: {
      panel_max: 0,
      judge: 0,
      synthesis: 100,
      end_to_end: 100
    },
    cost_usd: 0,
    metadata: {
      trace_id: "trc_responses",
      panel_size: 1,
      panel_models: ["openai/gpt-5.5"],
      judge_model: "openai/gpt-5.5",
      outer_model: "anthropic/claude-opus-4.8",
      runtime: "gateway",
      web_enabled: true,
      web_tools_available: true,
      web_fetch_available: true,
      local_tools_enabled: true,
      local_tools_available: true,
      judge_web_tools_available: true,
      outer_web_tools_available: true,
      web_extract_available: false
    },
    ...input
  };
}

async function json(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

async function text(response: Response) {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = "";

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      return output;
    }
    output += decoder.decode(chunk.value, { stream: true });
  }
}

function restoreApiKeys(value: string | undefined) {
  if (value === undefined) {
    delete process.env.FUSION_API_KEYS;
    return;
  }
  process.env.FUSION_API_KEYS = value;
}

test("Responses handler accepts string input and instructions", async () => {
  const previous = process.env.FUSION_API_KEYS;
  process.env.FUSION_API_KEYS = "";

  try {
    let seenDeveloper = "";
    let seenUser = "";
    const response = await handleOpenAIResponse(
      request({
        model: "openfusion",
        instructions: "Be terse.",
        input: "Say ok",
        max_output_tokens: 32,
        text: { format: { type: "text" } }
      }),
      {
        directRunner: async (runRequest) => {
          seenDeveloper = String(runRequest.messages?.[0]?.content ?? "");
          seenUser = String(runRequest.messages?.at(-1)?.content ?? "");
          assert.equal(runRequest.max_completion_tokens, 32);
          return fixtureRun({ requested_model: runRequest.model ?? "openfusion" });
        },
        saveRunRecord: async (run) => run,
        saveEvents: async (_runId, events: FusionRunEvent[]) => events
      }
    );
    const body = OpenAIResponseObjectSchema.parse(await json(response));

    assert.equal(response.status, 200);
    assert.equal(seenDeveloper, "Be terse.");
    assert.equal(seenUser, "Say ok");
    assert.equal(body.object, "response");
    assert.equal(body.output_text, "ok");
    assert.equal(body.output[0]?.type, "message");
    assert.equal(body.usage?.total_tokens, 4);
    assert.equal(body.fusion?.run_id, "run_responses");
  } finally {
    restoreApiKeys(previous);
  }
});

test("Responses handler maps function tools and forced function choice", async () => {
  const previous = process.env.FUSION_API_KEYS;
  process.env.FUSION_API_KEYS = "";

  try {
    let directCalled = false;
    let toolName = "";
    let choiceName = "";
    const response = await handleOpenAIResponse(
      request({
        model: "openfusion",
        input: "Read the file.",
        tools: [
          {
            type: "function",
            name: "read_file",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" }
              },
              required: ["path"]
            }
          }
        ],
        tool_choice: { type: "function", name: "read_file" }
      }),
      {
        directRunner: async () => {
          directCalled = true;
          return fixtureRun();
        },
        agenticRunner: async (runRequest) => {
          toolName = runRequest.client_tools?.[0]?.function.name ?? "";
          const choice = runRequest.client_tool_choice as {
            function?: { name?: string };
          };
          choiceName = choice.function?.name ?? "";
          return fixtureRun({
            final: "",
            metadata: {
              ...fixtureRun().metadata,
              client_tool_calls: [
                {
                  id: "call_read_file",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: JSON.stringify({ path: "README.md" })
                  }
                }
              ]
            }
          });
        },
        saveRunRecord: async (run) => run,
        saveEvents: async (_runId, events: FusionRunEvent[]) => events
      }
    );
    const body = OpenAIResponseObjectSchema.parse(await json(response));

    assert.equal(response.status, 200);
    assert.equal(directCalled, false);
    assert.equal(toolName, "read_file");
    assert.equal(choiceName, "read_file");
    assert.equal(body.output_text, "");
    const outputItem = body.output[0];
    assert.equal(outputItem?.type, "function_call");
    assert.equal(outputItem?.type === "function_call" ? outputItem.name : "", "read_file");
  } finally {
    restoreApiKeys(previous);
  }
});

test("Responses handler honors tool_choice none with function tools", async () => {
  const previous = process.env.FUSION_API_KEYS;
  process.env.FUSION_API_KEYS = "";

  try {
    let directCalled = false;
    let agenticCalled = false;
    const response = await handleOpenAIResponse(
      request({
        model: "openfusion",
        input: "Say ok.",
        tools: [{ type: "function", name: "read_file" }],
        tool_choice: "none"
      }),
      {
        directRunner: async (runRequest) => {
          directCalled = true;
          assert.equal(runRequest.client_tools?.[0]?.function.name, "read_file");
          assert.equal(runRequest.client_tool_choice, "none");
          return fixtureRun();
        },
        agenticRunner: async () => {
          agenticCalled = true;
          return fixtureRun();
        },
        saveRunRecord: async (run) => run,
        saveEvents: async (_runId, events: FusionRunEvent[]) => events
      }
    );

    assert.equal(response.status, 200);
    assert.equal(directCalled, true);
    assert.equal(agenticCalled, false);
  } finally {
    restoreApiKeys(previous);
  }
});

test("Responses handler tolerates null optional fields from OpenAI-compatible clients", async () => {
  const previous = process.env.FUSION_API_KEYS;
  process.env.FUSION_API_KEYS = "";

  try {
    let called = false;
    let seen: Record<string, unknown> = {};
    const response = await handleOpenAIResponse(
      request({
        model: "openfusion",
        input: "Say ok.",
        instructions: null,
        stream: null,
        temperature: null,
        top_p: null,
        parallel_tool_calls: null,
        max_output_tokens: null,
        previous_response_id: null,
        metadata: null,
        tools: null,
        tool_choice: null,
        text: null,
        reasoning: null,
        store: null,
        user: null
      }),
      {
        directRunner: async (runRequest) => {
          called = true;
          seen = {
            messageCount: runRequest.messages?.length,
            firstRole: runRequest.messages?.[0]?.role,
            temperature: runRequest.temperature,
            top_p: runRequest.top_p,
            max_completion_tokens: runRequest.max_completion_tokens,
            client_tools: runRequest.client_tools,
            client_tool_choice: runRequest.client_tool_choice,
            response_format: runRequest.response_format,
            reasoning: runRequest.fusion?.reasoning,
            metadata: runRequest.metadata
          };
          return fixtureRun();
        },
        saveRunRecord: async (run) => run,
        saveEvents: async (_runId, events: FusionRunEvent[]) => events
      }
    );

    assert.equal(response.status, 200);
    assert.equal(called, true);
    assert.deepEqual(seen, {
      messageCount: 1,
      firstRole: "user",
      temperature: undefined,
      top_p: undefined,
      max_completion_tokens: undefined,
      client_tools: [],
      client_tool_choice: undefined,
      response_format: undefined,
      reasoning: undefined,
      metadata: undefined
    });
  } finally {
    restoreApiKeys(previous);
  }
});

test("Responses handler rejects non-text input before running the council", async () => {
  const previous = process.env.FUSION_API_KEYS;
  process.env.FUSION_API_KEYS = "";

  try {
    let called = false;
    const response = await handleOpenAIResponse(
      request({
        model: "openfusion",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_image",
                image_url: "data:image/png;base64,abc"
              }
            ]
          }
        ]
      }),
      {
        directRunner: async () => {
          called = true;
          return fixtureRun();
        }
      }
    );
    const body = await json(response);

    assert.equal(response.status, 400);
    assert.equal(called, false);
    assert.match(String((body.error as { message?: string })?.message), /text input only/);
  } finally {
    restoreApiKeys(previous);
  }
});

test("Responses handler hydrates previous_response_id from saved OpenFusion runs", async () => {
  const previous = process.env.FUSION_API_KEYS;
  process.env.FUSION_API_KEYS = "";

  try {
    const prior = fixtureRun({
      id: "run_prev",
      prompt: "What did we decide?",
      final: "Ship the OpenFusion endpoint first."
    });
    let seenMessages: unknown[] = [];
    let seenParentRunId: string | undefined;

    const response = await handleOpenAIResponse(
      request({
        model: "openfusion",
        instructions: "Keep continuity.",
        previous_response_id: "resp_prev",
        input: "What is the next step?"
      }),
      {
        getRunRecord: async (id) => (id === "run_prev" ? prior : undefined),
        directRunner: async (runRequest) => {
          seenMessages = runRequest.messages ?? [];
          seenParentRunId = runRequest.metadata?.parent_run_id as string | undefined;
          return fixtureRun({ prompt: "What is the next step?", final: "Run the final verification." });
        },
        saveRunRecord: async (run) => run,
        saveEvents: async (_runId, events: FusionRunEvent[]) => events
      }
    );

    assert.equal(response.status, 200);
    assert.deepEqual(
      seenMessages.map((message) => (message as { role?: string }).role),
      ["developer", "user", "assistant", "user"]
    );
    assert.equal((seenMessages[1] as { content?: string }).content, "What did we decide?");
    assert.equal(
      (seenMessages[2] as { content?: string }).content,
      "Ship the OpenFusion endpoint first."
    );
    assert.equal((seenMessages[3] as { content?: string }).content, "What is the next step?");
    assert.equal(seenParentRunId, "run_prev");
  } finally {
    restoreApiKeys(previous);
  }
});

test("Responses handler rejects unknown previous_response_id before model work", async () => {
  const previous = process.env.FUSION_API_KEYS;
  process.env.FUSION_API_KEYS = "";

  try {
    let called = false;
    const response = await handleOpenAIResponse(
      request({
        model: "openfusion",
        previous_response_id: "resp_missing",
        input: "Continue."
      }),
      {
        getRunRecord: async () => undefined,
        directRunner: async () => {
          called = true;
          return fixtureRun();
        }
      }
    );
    const body = await json(response);

    assert.equal(response.status, 400);
    assert.equal(called, false);
    assert.match(String((body.error as { message?: string })?.message), /previous_response_id/);
  } finally {
    restoreApiKeys(previous);
  }
});

test("Responses handler streams Responses API events", async () => {
  const previous = process.env.FUSION_API_KEYS;
  process.env.FUSION_API_KEYS = "";

  try {
    const response = await handleOpenAIResponse(
      request({
        model: "openfusion",
        input: "Say ok.",
        stream: true
      }),
      {
        directRunner: async (_runRequest, options) => {
          options.onToken?.("ok");
          return fixtureRun();
        },
        saveRunRecord: async (run) => run,
        saveEvents: async (_runId, events: FusionRunEvent[]) => events
      }
    );
    const output = await text(response);

    assert.equal(response.status, 200);
    assert.match(output, /event: response.created/);
    assert.match(output, /event: response.output_text.delta/);
    assert.match(output, /"delta":"ok"/);
    assert.match(output, /event: response.completed/);
    assert.match(output.trim(), /\[DONE\]$/);
  } finally {
    restoreApiKeys(previous);
  }
});
