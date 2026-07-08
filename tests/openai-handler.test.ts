import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { handleOpenAIChatCompletion } from "../src/lib/fusion/openai-handler.ts";
import {
  FusionBudgetExceededError,
  FusionConfigurationError
} from "../src/lib/fusion/errors.ts";
import { OpenAIChatCompletionChunkSchema } from "../src/lib/fusion/schemas.ts";
import type { FusionRun, FusionRunEvent } from "../src/lib/fusion/types.ts";

const previousFusionDataDir = process.env.FUSION_DATA_DIR;
const testFusionDataDir = mkdtempSync(join(tmpdir(), "openfusion-openai-handler-"));
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
  return new Request("http://127.0.0.1:3000/v1/chat/completions", {
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
    id: "run_handler",
    object: "fusion.run",
    created_at: "2026-06-23T00:00:00.000Z",
    completed_at: "2026-06-23T00:00:01.000Z",
    mode: "fast",
    requested_model: "fast",
    status: "ok",
    degraded: false,
    prompt: "Reply with exactly ok.",
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
      panel_max: 0,
      judge: 0,
      synthesis: 100,
      end_to_end: 100
    },
    cost_usd: 0,
    metadata: {
      trace_id: "trc_handler",
      panel_size: 0,
      panel_models: [],
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

test("OpenAI handler enforces Fusion API auth before parsing or running", async () => {
  const previous = process.env.FUSION_API_KEYS;
  process.env.FUSION_API_KEYS = "secret";

  try {
    let called = false;
    const response = await handleOpenAIChatCompletion(
      request({
        model: "fast",
        messages: [{ role: "user", content: "ok" }]
      }),
      {
        directRunner: async () => {
          called = true;
          return fixtureRun();
        }
      }
    );

    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), 'Bearer realm="Fusion API"');
    assert.equal(called, false);
  } finally {
    restoreApiKeys(previous);
  }
});

test("OpenAI handler accepts bearer auth and routes direct aliases to the direct runner", async () => {
  const previous = process.env.FUSION_API_KEYS;
  process.env.FUSION_API_KEYS = "secret";

  try {
    let receivedMode = "";
    const response = await handleOpenAIChatCompletion(
      request(
        {
          model: "fast",
          messages: [{ role: "user", content: "ok" }]
        },
        {
          Authorization: "Bearer secret"
        }
      ),
      {
        directRunner: async (runRequest, options) => {
          receivedMode = runRequest.mode;
          await options.onEvent?.({
            id: "evt_handler",
            object: "fusion.run.event",
            run_id: "run_handler",
            sequence: 0,
            type: "run.started",
            created_at: "2026-06-23T00:00:00.000Z",
            data: {}
          });
          return fixtureRun({ mode: runRequest.mode, requested_model: runRequest.model ?? "fast" });
        },
        saveRunRecord: async (run) => run,
        saveEvents: async (_runId, events) => events
      }
    );
    const body = await json(response);

    assert.equal(response.status, 200);
    assert.equal(receivedMode, "fast");
    assert.equal(body.object, "chat.completion");
  } finally {
    restoreApiKeys(previous);
  }
});

test("OpenAI handler routes OpenRouter Fusion aliases to the agentic runner", async () => {
  const previous = process.env.FUSION_API_KEYS;
  process.env.FUSION_API_KEYS = "";

  try {
    let directCalled = false;
    let agenticMode = "";
    const response = await handleOpenAIChatCompletion(
      request({
        model: "openrouter/fusion",
        messages: [{ role: "user", content: "compare this" }]
      }),
      {
        directRunner: async () => {
          directCalled = true;
          return fixtureRun();
        },
        agenticRunner: async (runRequest) => {
          agenticMode = runRequest.mode;
          return fixtureRun({
            mode: runRequest.mode,
            requested_model: runRequest.model ?? "openrouter/fusion"
          });
        },
        saveRunRecord: async (run) => run,
        saveEvents: async (_runId, events: FusionRunEvent[]) => events
      }
    );
    const body = await json(response);

    assert.equal(response.status, 200);
    assert.equal(directCalled, false);
    assert.equal(agenticMode, "openfusion");
    assert.equal(body.object, "chat.completion");
  } finally {
    restoreApiKeys(previous);
  }
});

test("OpenAI handler passes Fusion plugin disablement to the agentic runner", async () => {
  const previous = process.env.FUSION_API_KEYS;
  process.env.FUSION_API_KEYS = "";

  try {
    let disabled: boolean | undefined;
    const response = await handleOpenAIChatCompletion(
      request({
        model: "openrouter/fusion",
        messages: [{ role: "user", content: "answer directly" }],
        tool_choice: "required",
        plugins: [
          {
            id: "fusion",
            enabled: false
          }
        ]
      }),
      {
        agenticRunner: async (runRequest) => {
          disabled = runRequest.fusion?.disabled;
          return fixtureRun({
            mode: runRequest.mode,
            requested_model: runRequest.model ?? "openrouter/fusion"
          });
        },
        saveRunRecord: async (run) => run,
        saveEvents: async (_runId, events: FusionRunEvent[]) => events
      }
    );

    assert.equal(response.status, 200);
    assert.equal(disabled, true);
  } finally {
    restoreApiKeys(previous);
  }
});

test("OpenAI handler passes strict OpenRouter Fusion mode to the agentic runner", async () => {
  const previous = process.env.FUSION_API_KEYS;
  process.env.FUSION_API_KEYS = "";

  try {
    let strict: boolean | undefined;
    const response = await handleOpenAIChatCompletion(
      request({
        model: "openrouter/fusion",
        messages: [{ role: "user", content: "compare this" }]
      }),
      {
        agenticRunner: async (runRequest) => {
          strict = runRequest.fusion?.strict;
          return fixtureRun({
            mode: runRequest.mode,
            requested_model: runRequest.model ?? "openrouter/fusion"
          });
        },
        saveRunRecord: async (run) => run,
        saveEvents: async (_runId, events: FusionRunEvent[]) => events
      }
    );

    assert.equal(response.status, 200);
    assert.equal(strict, true);
  } finally {
    restoreApiKeys(previous);
  }
});

test("OpenAI handler returns invalid_request_error for malformed requests", async () => {
  const response = await handleOpenAIChatCompletion(
    request({
      model: "fast",
      messages: []
    })
  );
  const body = await json(response) as { error?: { type?: string } };

  assert.equal(response.status, 400);
  assert.equal(body.error?.type, "invalid_request_error");
});

test("OpenAI handler rejects malformed function tools before running", async () => {
  let called = false;
  const response = await handleOpenAIChatCompletion(
    request({
      model: "fusion/fusion-8",
      messages: [{ role: "user", content: "inspect files" }],
      tools: [
        {
          type: "function",
          function: {
            description: "Missing a required name."
          }
        }
      ]
    }),
    {
      agenticRunner: async () => {
        called = true;
        return fixtureRun();
      },
      directRunner: async () => {
        called = true;
        return fixtureRun();
      }
    }
  );
  const body = await json(response) as { error?: { message?: string; type?: string } };

  assert.equal(response.status, 400);
  assert.equal(called, false);
  assert.equal(body.error?.type, "invalid_request_error");
  assert.match(body.error?.message ?? "", /Invalid OpenAI function tool at tools\[0\]/);
});

test("OpenAI handler accepts any model name and runs the active graph", async () => {
  let directCalled = false;
  const response = await handleOpenAIChatCompletion(
    request({
      model: "literally-anything",
      messages: [{ role: "user", content: "ok" }]
    }),
    {
      directRunner: async () => {
        directCalled = true;
        return fixtureRun();
      }
    }
  );

  // No model registry to fight: the active graph is the config, so any name runs.
  assert.equal(directCalled, true);
  assert.equal(response.status, 200);
});

test("OpenAI handler preserves max_completion_tokens for final answer caps", async () => {
  let receivedMaxTokens: number | undefined;
  let receivedMaxCompletionTokens: number | undefined;
  const response = await handleOpenAIChatCompletion(
    request({
      model: "fusion",
      messages: [{ role: "user", content: "ok" }],
      max_tokens: 8,
      max_completion_tokens: 128
    }),
    {
      directRunner: async (runRequest) => {
        receivedMaxTokens = runRequest.max_tokens;
        receivedMaxCompletionTokens = runRequest.max_completion_tokens;
        return fixtureRun();
      }
    }
  );

  assert.equal(response.status, 200);
  assert.equal(receivedMaxTokens, 8);
  assert.equal(receivedMaxCompletionTokens, 128);
});

test("OpenAI handler preserves common agent request knobs", async () => {
  let received: Record<string, unknown> = {};
  const responseFormat = {
    type: "json_object" as const
  };
  const streamOptions = { include_usage: true };
  const response = await handleOpenAIChatCompletion(
    request({
      model: "fusion",
      messages: [{ role: "user", content: "ok" }],
      temperature: 0.4,
      top_p: 0.8,
      presence_penalty: 0.1,
      frequency_penalty: -0.1,
      seed: 123,
      stop: ["</stop>"],
      response_format: responseFormat,
      stream_options: streamOptions,
      n: 1,
      modalities: ["text"],
      parallel_tool_calls: true
    }),
    {
      directRunner: async (runRequest) => {
        received = {
          temperature: runRequest.temperature,
          top_p: runRequest.top_p,
          presence_penalty: runRequest.presence_penalty,
          frequency_penalty: runRequest.frequency_penalty,
          seed: runRequest.seed,
          stop: runRequest.stop,
          response_format: runRequest.response_format,
          stream_options: runRequest.stream_options
        };
        return fixtureRun({ final: "{\"ok\":true}" });
      },
      saveRunRecord: async (run) => run,
      saveEvents: async (_runId, events) => events
    }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(received, {
    temperature: 0.4,
    top_p: 0.8,
    presence_penalty: 0.1,
    frequency_penalty: -0.1,
    seed: 123,
    stop: ["</stop>"],
    response_format: responseFormat,
    stream_options: streamOptions
  });
});

test("OpenAI handler tolerates null optional fields from OpenAI-compatible clients", async () => {
  let called = false;
  let received: Record<string, unknown> = {};
  const response = await handleOpenAIChatCompletion(
    request({
      model: "fusion",
      messages: [{ role: "user", content: "ok" }],
      stream: null,
      temperature: null,
      top_p: null,
      presence_penalty: null,
      frequency_penalty: null,
      seed: null,
      stop: null,
      max_tokens: null,
      max_completion_tokens: null,
      n: null,
      modalities: null,
      response_format: null,
      stream_options: null,
      parallel_tool_calls: null,
      user: null,
      tools: null,
      tool_choice: null,
      functions: null,
      function_call: null,
      plugins: null,
      reasoning: null,
      metadata: null
    }),
    {
      directRunner: async (runRequest) => {
        called = true;
        received = {
          stream: runRequest.stream,
          temperature: runRequest.temperature,
          top_p: runRequest.top_p,
          stop: runRequest.stop,
          max_tokens: runRequest.max_tokens,
          max_completion_tokens: runRequest.max_completion_tokens,
          client_tools: runRequest.client_tools,
          client_tool_choice: runRequest.client_tool_choice,
          response_format: runRequest.response_format,
          stream_options: runRequest.stream_options,
          metadata: runRequest.metadata
        };
        return fixtureRun();
      },
      saveRunRecord: async (run) => run,
      saveEvents: async (_runId, events) => events
    }
  );

  assert.equal(response.status, 200);
  assert.equal(called, true);
  assert.deepEqual(received, {
    stream: undefined,
    temperature: undefined,
    top_p: undefined,
    stop: undefined,
    max_tokens: undefined,
    max_completion_tokens: undefined,
    client_tools: [],
    client_tool_choice: undefined,
    response_format: undefined,
    stream_options: undefined,
    metadata: undefined
  });
});

test("OpenAI handler accepts developer messages and text content parts", async () => {
  let receivedRoles: string[] = [];
  let receivedUserContent: unknown;
  const response = await handleOpenAIChatCompletion(
    request({
      model: "fusion",
      messages: [
        {
          role: "developer",
          content: [{ type: "text", text: "Keep replies tight." }]
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Read this." },
            { type: "text", text: "List risks." }
          ]
        }
      ]
    }),
    {
      directRunner: async (runRequest) => {
        receivedRoles = runRequest.messages?.map((message) => message.role) ?? [];
        receivedUserContent = runRequest.messages?.find((message) => message.role === "user")?.content;
        return fixtureRun();
      },
      saveRunRecord: async (run) => run,
      saveEvents: async (_runId, events) => events
    }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(receivedRoles, ["developer", "user"]);
  assert.deepEqual(receivedUserContent, [
    { type: "text", text: "Read this." },
    { type: "text", text: "List risks." }
  ]);
});

test("OpenAI handler rejects non-text content parts before running the council", async () => {
  let called = false;
  const response = await handleOpenAIChatCompletion(
    request({
      model: "fusion",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this image?" },
            {
              type: "image_url",
              image_url: {
                url: "data:image/png;base64,AAAA"
              }
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
  const body = await json(response) as { error?: { message?: string } };

  assert.equal(response.status, 400);
  assert.equal(called, false);
  assert.match(body.error?.message ?? "", /only supports text chat content parts/);
  assert.match(body.error?.message ?? "", /image_url/);
});

test("OpenAI handler rejects unsupported multi-choice completions", async () => {
  let called = false;
  const response = await handleOpenAIChatCompletion(
    request({
      model: "fusion",
      messages: [{ role: "user", content: "ok" }],
      n: 2
    }),
    {
      directRunner: async () => {
        called = true;
        return fixtureRun();
      }
    }
  );
  const body = await json(response) as { error?: { message?: string } };

  assert.equal(response.status, 400);
  assert.equal(called, false);
  assert.match(body.error?.message ?? "", /n must be 1/);
});

test("OpenAI handler rejects non-text modalities", async () => {
  let called = false;
  const response = await handleOpenAIChatCompletion(
    request({
      model: "fusion",
      messages: [{ role: "user", content: "ok" }],
      modalities: ["text", "audio"]
    }),
    {
      directRunner: async () => {
        called = true;
        return fixtureRun();
      }
    }
  );
  const body = await json(response) as { error?: { message?: string } };

  assert.equal(response.status, 400);
  assert.equal(called, false);
  assert.match(body.error?.message ?? "", /only supports text/);
});

test("OpenAI handler streams usage when stream_options.include_usage is true", async () => {
  const response = await handleOpenAIChatCompletion(
    request({
      model: "fusion",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "ok" }]
    }),
    {
      directRunner: async () => fixtureRun({
        usage: {
          input_tokens: 10,
          output_tokens: 3,
          total_tokens: 13
        }
      }),
      saveRunRecord: async (run) => run,
      saveEvents: async (_runId, events) => events
    }
  );

  assert.equal(response.status, 200);
  const events = (await text(response))
    .trim()
    .split("\n\n")
    .map((event) => event.replace(/^data: /, ""));
  assert.equal(events.at(-1), "[DONE]");
  const chunks = events.slice(0, -1).map((event) => JSON.parse(event));
  chunks.forEach((chunk) => OpenAIChatCompletionChunkSchema.parse(chunk));

  const usageChunk = chunks.find((chunk) => Array.isArray(chunk.choices) && chunk.choices.length === 0);
  assert.ok(usageChunk);
  assert.deepEqual(usageChunk.usage, {
    prompt_tokens: 10,
    completion_tokens: 3,
    total_tokens: 13
  });
});

test("OpenAI handler buffers streamed text for JSON response_format", async () => {
  const response = await handleOpenAIChatCompletion(
    request({
      model: "fusion",
      stream: true,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: "return json" }]
    }),
    {
      directRunner: async (_runRequest, options) => {
        options.onToken?.("this should not stream");
        return fixtureRun({ final: "{\"ok\":true}" });
      },
      saveRunRecord: async (run) => run,
      saveEvents: async (_runId, events) => events
    }
  );

  assert.equal(response.status, 200);
  const events = (await text(response))
    .trim()
    .split("\n\n")
    .map((event) => event.replace(/^data: /, ""));
  assert.equal(events.at(-1), "[DONE]");
  const chunks = events.slice(0, -1).map((event) => JSON.parse(event));
  chunks.forEach((chunk) => OpenAIChatCompletionChunkSchema.parse(chunk));

  const content = chunks
    .map((chunk) => chunk.choices[0]?.delta?.content)
    .filter((entry): entry is string => typeof entry === "string")
    .join("");
  assert.equal(content, "{\"ok\":true}");
  assert.equal(content.includes("this should not stream"), false);
});

test("OpenAI handler fails JSON response_format requests when final output is not JSON", async () => {
  let saved = false;
  const response = await handleOpenAIChatCompletion(
    request({
      model: "fusion",
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: "return json" }]
    }),
    {
      directRunner: async () => fixtureRun({ final: "not json" }),
      saveRunRecord: async (run) => {
        saved = true;
        return run;
      }
    }
  );
  const body = await json(response) as { error?: { message?: string } };

  assert.equal(response.status, 400);
  assert.equal(saved, false);
  assert.match(body.error?.message ?? "", /did not satisfy response_format/);
});

test("OpenAI handler rejects JSON object mode when output is not an object", async () => {
  let saved = false;
  const response = await handleOpenAIChatCompletion(
    request({
      model: "fusion",
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: "return json" }]
    }),
    {
      directRunner: async () => fixtureRun({ final: "[1,2,3]" }),
      saveRunRecord: async (run) => {
        saved = true;
        return run;
      }
    }
  );
  const body = await json(response) as { error?: { message?: string } };

  assert.equal(response.status, 400);
  assert.equal(saved, false);
  assert.match(body.error?.message ?? "", /not a JSON object/);
});

test("OpenAI handler validates json_schema response_format before saving", async () => {
  let saved = false;
  const response = await handleOpenAIChatCompletion(
    request({
      model: "fusion",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ok: { type: "boolean" }
            },
            required: ["ok"]
          }
        }
      },
      messages: [{ role: "user", content: "return json" }]
    }),
    {
      directRunner: async () => fixtureRun({ final: "{\"ok\":true}" }),
      saveRunRecord: async (run) => {
        saved = true;
        return run;
      },
      saveEvents: async (_runId, events) => events
    }
  );

  assert.equal(response.status, 200);
  assert.equal(saved, true);
});

test("OpenAI handler rejects json_schema output that misses required fields", async () => {
  let saved = false;
  const response = await handleOpenAIChatCompletion(
    request({
      model: "fusion",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ok: { type: "boolean" }
            },
            required: ["ok"]
          }
        }
      },
      messages: [{ role: "user", content: "return json" }]
    }),
    {
      directRunner: async () => fixtureRun({ final: "{\"nope\":true}" }),
      saveRunRecord: async (run) => {
        saved = true;
        return run;
      }
    }
  );
  const body = await json(response) as { error?: { message?: string } };

  assert.equal(response.status, 400);
  assert.equal(saved, false);
  assert.match(body.error?.message ?? "", /json_schema/);
  assert.match(body.error?.message ?? "", /required property/);
});

test("OpenAI handler rejects invalid json_schema before running the council", async () => {
  let called = false;
  const response = await handleOpenAIChatCompletion(
    request({
      model: "fusion",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "bad_schema",
          schema: {
            type: "definitely-not-a-json-schema-type"
          }
        }
      },
      messages: [{ role: "user", content: "return json" }]
    }),
    {
      directRunner: async () => {
        called = true;
        return fixtureRun({ final: "{}" });
      }
    }
  );
  const body = await json(response) as { error?: { message?: string } };

  assert.equal(response.status, 400);
  assert.equal(called, false);
  assert.match(body.error?.message ?? "", /Invalid response_format json_schema/);
});

test("OpenAI handler routes direct aliases with client tools through agentic Fusion", async () => {
  let directCalled = false;
  let receivedMode = "";
  const response = await handleOpenAIChatCompletion(
    request({
      model: "fusion/fusion-8",
      messages: [{ role: "user", content: "edit this repository" }],
      tools: [
        {
          type: "function",
          function: {
            name: "edit_file"
          }
        }
      ]
    }),
    {
      directRunner: async () => {
        directCalled = true;
        return fixtureRun();
      },
      agenticRunner: async (runRequest) => {
        receivedMode = runRequest.mode;
        return fixtureRun({
          mode: runRequest.mode,
          requested_model: runRequest.model ?? "fusion/fusion-8",
          final: "",
          metadata: {
            ...fixtureRun().metadata,
            client_tool_calls: [
              {
                id: "call_edit_file",
                type: "function",
                function: {
                  name: "edit_file",
                  arguments: JSON.stringify({ path: "README.md" })
                }
              }
            ]
          }
        });
      }
    }
  );
  const body = await json(response) as {
    choices?: Array<{
      finish_reason?: string;
      message?: {
        tool_calls?: Array<{ function?: { name?: string } }>;
      };
    }>;
  };

  assert.equal(response.status, 200);
  assert.equal(directCalled, false);
  assert.equal(receivedMode, "fusion-8");
  assert.equal(body.choices?.[0]?.finish_reason, "tool_calls");
  assert.equal(body.choices?.[0]?.message?.tool_calls?.[0]?.function?.name, "edit_file");
});

test("OpenAI handler normalizes legacy functions and function_call", async () => {
  let directCalled = false;
  let receivedToolCount = 0;
  let receivedToolChoice: unknown;
  const response = await handleOpenAIChatCompletion(
    request({
      model: "fusion/fusion-8",
      messages: [{ role: "user", content: "inspect this repository" }],
      functions: [
        {
          name: "read_file",
          description: "Read a file from the client workspace.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" }
            },
            required: ["path"]
          }
        }
      ],
      function_call: {
        name: "read_file"
      }
    }),
    {
      directRunner: async () => {
        directCalled = true;
        return fixtureRun();
      },
      agenticRunner: async (runRequest) => {
        receivedToolCount = runRequest.client_tools?.length ?? 0;
        receivedToolChoice = runRequest.client_tool_choice;
        return fixtureRun({
          mode: runRequest.mode,
          requested_model: runRequest.model ?? "fusion/fusion-8",
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
  const body = await json(response) as {
    choices?: Array<{
      finish_reason?: string;
      message?: {
        tool_calls?: Array<{ function?: { name?: string } }>;
      };
    }>;
  };

  assert.equal(response.status, 200);
  assert.equal(directCalled, false);
  assert.equal(receivedToolCount, 1);
  assert.deepEqual(receivedToolChoice, {
    type: "function",
    function: {
      name: "read_file"
    }
  });
  assert.equal(body.choices?.[0]?.finish_reason, "tool_calls");
  assert.equal(body.choices?.[0]?.message?.tool_calls?.[0]?.function?.name, "read_file");
});

test("OpenAI handler honors tool_choice none with client tools", async () => {
  let directCalled = false;
  let agenticCalled = false;
  let receivedToolCount = 0;
  let receivedToolChoice: unknown;
  const response = await handleOpenAIChatCompletion(
    request({
      model: "fusion/fusion-8",
      messages: [{ role: "user", content: "answer without reading files" }],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file"
          }
        }
      ],
      tool_choice: "none"
    }),
    {
      directRunner: async (runRequest) => {
        directCalled = true;
        receivedToolCount = runRequest.client_tools?.length ?? 0;
        receivedToolChoice = runRequest.client_tool_choice;
        return fixtureRun({ final: "no tools used" });
      },
      agenticRunner: async () => {
        agenticCalled = true;
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
                  arguments: "{}"
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
  const body = await json(response) as {
    choices?: Array<{
      finish_reason?: string;
      message?: {
        content?: string | null;
        tool_calls?: Array<unknown>;
      };
    }>;
  };

  assert.equal(response.status, 200);
  assert.equal(directCalled, true);
  assert.equal(agenticCalled, false);
  assert.equal(receivedToolCount, 1);
  assert.equal(receivedToolChoice, "none");
  assert.equal(body.choices?.[0]?.finish_reason, "stop");
  assert.equal(body.choices?.[0]?.message?.content, "no tools used");
  assert.equal(body.choices?.[0]?.message?.tool_calls, undefined);
});

test("OpenAI handler honors legacy function_call none", async () => {
  let directCalled = false;
  let agenticCalled = false;
  let receivedToolChoice: unknown;
  const response = await handleOpenAIChatCompletion(
    request({
      model: "fusion/fusion-8",
      messages: [{ role: "user", content: "answer without reading files" }],
      functions: [
        {
          name: "read_file"
        }
      ],
      function_call: "none"
    }),
    {
      directRunner: async (runRequest) => {
        directCalled = true;
        receivedToolChoice = runRequest.client_tool_choice;
        return fixtureRun({ final: "legacy none honored" });
      },
      agenticRunner: async () => {
        agenticCalled = true;
        return fixtureRun();
      },
      saveRunRecord: async (run) => run,
      saveEvents: async (_runId, events: FusionRunEvent[]) => events
    }
  );
  const body = await json(response) as {
    choices?: Array<{
      finish_reason?: string;
      message?: {
        content?: string | null;
        tool_calls?: Array<unknown>;
      };
    }>;
  };

  assert.equal(response.status, 200);
  assert.equal(directCalled, true);
  assert.equal(agenticCalled, false);
  assert.equal(receivedToolChoice, "none");
  assert.equal(body.choices?.[0]?.finish_reason, "stop");
  assert.equal(body.choices?.[0]?.message?.content, "legacy none honored");
  assert.equal(body.choices?.[0]?.message?.tool_calls, undefined);
});

test("OpenAI handler returns client tool calls from the agentic Fusion path", async () => {
  let receivedToolCount = 0;
  let receivedToolChoice: unknown;
  const response = await handleOpenAIChatCompletion(
    request({
      model: "openrouter/fusion",
      messages: [{ role: "user", content: "inspect the repo" }],
      tools: [
        {
          type: "openrouter:fusion"
        },
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read a file from the client workspace.",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" }
              },
              required: ["path"]
            }
          }
        }
      ],
      tool_choice: {
        type: "function",
        function: {
          name: "read_file"
        }
      }
    }),
    {
      agenticRunner: async (runRequest) => {
        receivedToolCount = runRequest.client_tools?.length ?? 0;
        receivedToolChoice = runRequest.client_tool_choice;
        return fixtureRun({
          mode: runRequest.mode,
          requested_model: runRequest.model ?? "openrouter/fusion",
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
  const body = await json(response) as {
    choices?: Array<{
      finish_reason?: string;
      message?: {
        content?: string | null;
        tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
      };
    }>;
  };

  assert.equal(response.status, 200);
  assert.equal(receivedToolCount, 1);
  assert.deepEqual(receivedToolChoice, {
    type: "function",
    function: {
      name: "read_file"
    }
  });
  assert.equal(body.choices?.[0]?.finish_reason, "tool_calls");
  assert.equal(body.choices?.[0]?.message?.content, null);
  assert.equal(body.choices?.[0]?.message?.tool_calls?.[0]?.function?.name, "read_file");
  assert.equal(
    body.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments,
    JSON.stringify({ path: "README.md" })
  );
});

test("OpenAI handler preserves client tool results as context for continuation", async () => {
  let receivedContext: unknown[] = [];
  const response = await handleOpenAIChatCompletion(
    request({
      model: "openrouter/fusion",
      messages: [
        { role: "user", content: "Read README.md and summarize setup." },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_read_file",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: "README.md" })
              }
            }
          ]
        },
        {
          role: "tool",
          tool_call_id: "call_read_file",
          name: "read_file",
          content: "# Fusion\n\nSetup starts with npm install."
        }
      ]
    }),
    {
      agenticRunner: async (runRequest) => {
        receivedContext = runRequest.context_messages ?? [];
        return fixtureRun({
          mode: runRequest.mode,
          requested_model: runRequest.model ?? "openrouter/fusion",
          final: "Setup starts with npm install."
        });
      },
      saveRunRecord: async (run) => run,
      saveEvents: async (_runId, events: FusionRunEvent[]) => events
    }
  );

  assert.equal(response.status, 200);
  assert.equal(receivedContext.length, 2);
  assert.deepEqual(receivedContext[0], {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call_read_file",
        type: "function",
        function: {
          name: "read_file",
          arguments: JSON.stringify({ path: "README.md" })
        }
      }
    ]
  });
  assert.deepEqual(receivedContext[1], {
    role: "tool",
    content: "# Fusion\n\nSetup starts with npm install.",
    name: "read_file",
    tool_call_id: "call_read_file"
  });
});

test("OpenAI handler preserves multi-step client tool loops in order", async () => {
  let receivedContext: unknown[] = [];
  let receivedMode = "";
  let receivedToolCount = -1;
  const response = await handleOpenAIChatCompletion(
    request({
      model: "fusion/fusion-8",
      messages: [
        { role: "user", content: "Read README.md and package.json, then summarize setup." },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_readme",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: "README.md" })
              }
            }
          ]
        },
        {
          role: "tool",
          tool_call_id: "call_readme",
          name: "read_file",
          content: "# Fusion\n\nUse npm install."
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_package",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: "package.json" })
              }
            }
          ]
        },
        {
          role: "tool",
          tool_call_id: "call_package",
          name: "read_file",
          content: "{\"scripts\":{\"verify\":\"npm run typecheck && npm run test && npm run build\"}}"
        }
      ]
    }),
    {
      agenticRunner: async (runRequest) => {
        receivedContext = runRequest.context_messages ?? [];
        receivedMode = runRequest.mode;
        receivedToolCount = runRequest.client_tools?.length ?? 0;
        return fixtureRun({
          mode: runRequest.mode,
          requested_model: runRequest.model ?? "fusion/fusion-8",
          final: "Setup uses npm install and npm run verify."
        });
      },
      directRunner: async () => {
        throw new Error("Tool transcript continuations should route through agentic Fusion.");
      },
      saveRunRecord: async (run) => run,
      saveEvents: async (_runId, events: FusionRunEvent[]) => events
    }
  );

  assert.equal(response.status, 200);
  assert.equal(receivedMode, "fusion-8");
  assert.equal(receivedToolCount, 0);
  assert.equal(receivedContext.length, 4);
  assert.deepEqual(
    receivedContext.map((message) => (message as { role?: string }).role),
    ["assistant", "tool", "assistant", "tool"]
  );
  assert.equal((receivedContext[0] as { tool_calls?: unknown[] }).tool_calls?.length, 1);
  assert.equal((receivedContext[2] as { tool_calls?: unknown[] }).tool_calls?.length, 1);
  assert.equal((receivedContext[3] as { tool_call_id?: string }).tool_call_id, "call_package");
});

test("OpenAI handler streams client tool calls from the agentic Fusion path", async () => {
  let receivedStream = false;
  let receivedToolCount = 0;
  let receivedMode = "";
  const response = await handleOpenAIChatCompletion(
    request({
      model: "fusion/fusion-8",
      stream: true,
      messages: [{ role: "user", content: "inspect this" }],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file"
          }
        }
      ]
    }),
    {
      agenticRunner: async (runRequest) => {
        receivedStream = Boolean(runRequest.stream);
        receivedToolCount = runRequest.client_tools?.length ?? 0;
        receivedMode = runRequest.mode;
        return fixtureRun({
          mode: runRequest.mode,
          requested_model: runRequest.model ?? "fusion/fusion-8",
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

  assert.equal(response.status, 200);
  assert.equal(receivedStream, true);
  assert.equal(receivedToolCount, 1);
  assert.equal(receivedMode, "fusion-8");

  const events = (await text(response))
    .trim()
    .split("\n\n")
    .map((event) => event.replace(/^data: /, ""));

  assert.equal(events.at(-1), "[DONE]");
  const chunks = events.slice(0, -1).map((event) => JSON.parse(event));
  chunks.forEach((chunk) => OpenAIChatCompletionChunkSchema.parse(chunk));

  assert.equal(chunks[0].choices[0].delta.role, "assistant");
  const toolChunk = chunks.find(
    (chunk) => chunk.choices[0].delta.tool_calls?.[0]?.function?.name === "read_file"
  );
  assert.ok(toolChunk);
  assert.equal(toolChunk.choices[0].delta.tool_calls[0].index, 0);
  assert.equal(toolChunk.choices[0].delta.tool_calls[0].id, "call_read_file");
  assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
});

test("OpenAI handler streams synthesizer tokens and does not re-send the final answer", async () => {
  const response = await handleOpenAIChatCompletion(
    request({
      model: "fusion",
      stream: true,
      messages: [{ role: "user", content: "ok" }]
    }),
    {
      directRunner: async (_runRequest, options) => {
        options.onToken?.("Hel");
        options.onToken?.("lo");
        return fixtureRun();
      },
      saveRunRecord: async (run) => run,
      saveEvents: async (_runId, events) => events
    }
  );

  assert.equal(response.status, 200);
  const events = (await text(response))
    .trim()
    .split("\n\n")
    .map((event) => event.replace(/^data: /, ""));
  assert.equal(events.at(-1), "[DONE]");
  const chunks = events.slice(0, -1).map((event) => JSON.parse(event));
  chunks.forEach((chunk) => OpenAIChatCompletionChunkSchema.parse(chunk));

  const streamed = chunks
    .map((chunk) => chunk.choices[0].delta.content)
    .filter((content): content is string => typeof content === "string")
    .join("");
  // Tokens arrived incrementally...
  assert.equal(streamed, "Hello");
  // ...and the run's final text was NOT re-sent as a duplicate content chunk.
  assert.equal(
    chunks.filter((chunk) => chunk.choices[0].delta.content === fixtureRun().final).length,
    0
  );
  assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
});

test("OpenAI handler streams synthesizer tokens from the agentic Fusion path", async () => {
  // The OpenRouter-style alias runs the agentic path; it must token-stream just
  // like the direct path, not deliver the answer in a single final chunk.
  let receivedOnToken = false;
  const response = await handleOpenAIChatCompletion(
    request({
      model: "openrouter/fusion",
      stream: true,
      messages: [{ role: "user", content: "compare this" }]
    }),
    {
      agenticRunner: async (_runRequest, options) => {
        receivedOnToken = typeof options.onToken === "function";
        options.onToken?.("Hel");
        options.onToken?.("lo");
        return fixtureRun();
      },
      saveRunRecord: async (run) => run,
      saveEvents: async (_runId, events) => events
    }
  );

  assert.equal(response.status, 200);
  assert.equal(receivedOnToken, true);
  const events = (await text(response))
    .trim()
    .split("\n\n")
    .map((event) => event.replace(/^data: /, ""));
  assert.equal(events.at(-1), "[DONE]");
  const chunks = events.slice(0, -1).map((event) => JSON.parse(event));
  chunks.forEach((chunk) => OpenAIChatCompletionChunkSchema.parse(chunk));

  const streamed = chunks
    .map((chunk) => chunk.choices[0].delta.content)
    .filter((content): content is string => typeof content === "string")
    .join("");
  assert.equal(streamed, "Hello");
  // The final text must not be re-sent as a duplicate content chunk.
  assert.equal(
    chunks.filter((chunk) => chunk.choices[0].delta.content === fixtureRun().final).length,
    0
  );
  assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
});

test("OpenAI handler streams live runtime events before final content", async () => {
  const emittedEvent: FusionRunEvent = {
    id: "evt_stream",
    object: "fusion.run.event",
    run_id: "run_handler",
    sequence: 0,
    type: "panel.started",
    created_at: "2026-06-23T00:00:00.000Z",
    data: {
      trace_id: "trc_handler",
      model: "deepseek/deepseek-v4-pro"
    }
  };
  let savedEventCount = 0;

  const response = await handleOpenAIChatCompletion(
    request({
      model: "fast",
      stream: true,
      messages: [{ role: "user", content: "ok" }]
    }),
    {
      directRunner: async (_runRequest, options) => {
        await options.onEvent?.(emittedEvent);
        return fixtureRun();
      },
      saveRunRecord: async (run) => run,
      saveEvents: async (_runId, events) => {
        savedEventCount = events.length;
        return events;
      }
    }
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

  const events = (await text(response))
    .trim()
    .split("\n\n")
    .map((event) => event.replace(/^data: /, ""));

  assert.equal(events.at(-1), "[DONE]");
  const chunks = events.slice(0, -1).map((event) => JSON.parse(event));
  chunks.forEach((chunk) => OpenAIChatCompletionChunkSchema.parse(chunk));

  assert.equal(chunks[0].choices[0].delta.role, "assistant");
  assert.equal(
    chunks.some((chunk) => chunk.fusion_event?.type === "panel.started"),
    true
  );
  assert.equal(
    chunks.some((chunk) => chunk.choices[0].delta.content === "ok"),
    true
  );
  assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
  assert.equal(savedEventCount, 1);
});

test("OpenAI handler reports configuration errors without masking them as bad requests", async () => {
  const response = await handleOpenAIChatCompletion(
    request({
      model: "fast",
      messages: [{ role: "user", content: "ok" }]
    }),
    {
      directRunner: async () => {
        throw new FusionConfigurationError("Set AI_GATEWAY_API_KEY.");
      }
    }
  );
  const body = await json(response) as { error?: { type?: string; message?: string } };

  assert.equal(response.status, 503);
  assert.equal(body.error?.type, "configuration_required");
  assert.equal(body.error?.message, "Set AI_GATEWAY_API_KEY.");
});

test("OpenAI handler maps a budget refusal to 402 budget_exceeded", async () => {
  const response = await handleOpenAIChatCompletion(
    request({
      model: "openfusion",
      messages: [{ role: "user", content: "ok" }]
    }),
    {
      directRunner: async () => {
        throw new FusionBudgetExceededError("Daily hosted spend cap reached.", {
          window: "day",
          cap_usd: 5,
          spent_usd: 5
        });
      }
    }
  );
  const body = await json(response) as { error?: { type?: string; message?: string } };

  assert.equal(response.status, 402);
  assert.equal(body.error?.type, "budget_exceeded");
  assert.equal(body.error?.message, "Daily hosted spend cap reached.");
});

test("OpenAI handler explains provider no-output failures from tiny token caps", async () => {
  const response = await handleOpenAIChatCompletion(
    request({
      model: "openfusion",
      max_completion_tokens: 8,
      messages: [{ role: "user", content: "ok" }]
    }),
    {
      directRunner: async () => {
        throw new Error("No output generated. Check the stream for errors.");
      }
    }
  );
  const body = await json(response) as { error?: { type?: string; message?: string } };

  assert.equal(response.status, 400);
  assert.equal(body.error?.type, "invalid_request_error");
  assert.match(body.error?.message ?? "", /max_completion_tokens/);
});
