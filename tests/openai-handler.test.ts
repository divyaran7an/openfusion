import assert from "node:assert/strict";
import test from "node:test";

import { handleOpenAIChatCompletion } from "../src/lib/fusion/openai-handler.ts";
import { FusionConfigurationError } from "../src/lib/fusion/errors.ts";
import { OpenAIChatCompletionChunkSchema } from "../src/lib/fusion/schemas.ts";
import type { FusionRun, FusionRunEvent } from "../src/lib/fusion/types.ts";

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
    assert.equal(agenticMode, "fusion-3");
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
