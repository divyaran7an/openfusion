import { requireApiAuth } from "./auth.ts";
import {
  assertSupportedClientTools,
  clientFunctionTools,
  fusionOverrideFromOpenAIRequest,
  normalizedClientToolChoice,
  shouldUseAgenticFusion
} from "./fusion-config.ts";
import { modeFromModel } from "./models.ts";
import { mergeActiveGraph } from "./active-graph.ts";
import { openAICompletionFromRun, toolCallDeltas } from "./openai.ts";
import { FusionBudgetExceededError, FusionConfigurationError } from "./errors.ts";
import { assertRunWithinBudget } from "./budget.ts";
import {
  assertOpenAICompatibility,
  assertResponseFormatSatisfied,
  assertResponseFormatSupported,
  openAIUsage,
  requiresBufferedResponse,
  wantsStreamUsage
} from "./openai-compat.ts";
import {
  completeRunEvents,
  failRunEvents,
  publishRunEvent
} from "./run-event-bus.ts";
import {
  OpenAIChatCompletionRequestSchema,
  type ChatMessage,
  type RunRequest
} from "./schemas.ts";
import { saveRun, saveRunEvents } from "./store.ts";
import type { FusionRun, FusionRunEvent } from "./types.ts";

type Runner = (
  request: RunRequest,
  options: {
    onEvent?: (event: FusionRunEvent) => void | Promise<void>;
    onToken?: (delta: string) => void;
    signal?: AbortSignal;
  }
) => Promise<FusionRun>;

export type OpenAIHandlerDeps = {
  directRunner?: Runner;
  agenticRunner?: Runner;
  saveRunRecord?: (run: FusionRun) => Promise<FusionRun>;
  saveEvents?: (runId: string, events: FusionRunEvent[]) => Promise<FusionRunEvent[]>;
};

async function defaultDirectRunner(...args: Parameters<Runner>) {
  const { runFusion } = await import("./orchestrator.ts");
  return runFusion(...args);
}

async function defaultAgenticRunner(...args: Parameters<Runner>) {
  const { runFusionAgentic } = await import("./orchestrator.ts");
  return runFusionAgentic(...args);
}

function jsonError(type: string, message: string, status: number) {
  // Full OpenAI error envelope (message, type, param, code) so strict SDK error
  // parsers read it cleanly; param/code are null because Fusion errors aren't
  // tied to a single request field.
  return Response.json(
    {
      error: {
        message,
        type,
        param: null,
        code: null
      }
    },
    { status }
  );
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Invalid request.";
  if (/No output generated/i.test(message)) {
    return `${message} If the request set a very small max_completion_tokens or max_tokens, increase it; some reasoning models can consume the cap before visible text.`;
  }
  return message;
}

function streamId() {
  return `chatcmpl_live_${crypto.randomUUID().replaceAll("-", "")}`;
}

function encodeSse(payload: unknown) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function chunkPayload(options: {
  id: string;
  created: number;
  model: string;
  delta?: Record<string, unknown>;
  emptyChoices?: boolean;
  finishReason?: "stop" | "error" | "tool_calls" | null;
  fusion?: ReturnType<typeof openAICompletionFromRun>["fusion"];
  fusionEvent?: FusionRunEvent;
  usage?: ReturnType<typeof openAIUsage> | null;
  error?: { type: string; message: string };
}) {
  return {
    id: options.id,
    object: "chat.completion.chunk",
    created: options.created,
    model: options.model,
    choices: options.emptyChoices
      ? []
      : [
          {
            index: 0,
            delta: options.delta ?? {},
            finish_reason: options.finishReason ?? null
          }
        ],
    ...(options.usage !== undefined ? { usage: options.usage } : {}),
    ...(options.fusion ? { fusion: options.fusion } : {}),
    ...(options.fusionEvent ? { fusion_event: options.fusionEvent } : {}),
    ...(options.error ? { error: options.error } : {})
  };
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string) {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function metadataNumber(metadata: Record<string, unknown> | undefined, key: string) {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function contextMessagesForOpenAI(messages: ChatMessage[]) {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }

  if (lastUserIndex < 0) {
    return messages.length > 1 ? messages.slice(0, -1) : undefined;
  }

  const context = messages.filter((_, index) => index !== lastUserIndex);
  return context.length > 0 ? context : undefined;
}

function modeForOpenAIRequest(model: string) {
  // Any model name is valid — the active graph drives the actual config, so the
  // mode is only a metadata label. Unknown names fall back to a neutral label.
  try {
    return modeFromModel(model);
  } catch {
    return "openfusion";
  }
}

function streamOpenAICompletionLive(options: {
  model: string;
  runInput: RunRequest;
  runner: Runner;
  signal?: AbortSignal;
  saveRunRecord: (run: FusionRun) => Promise<FusionRun>;
  saveEvents: (runId: string, events: FusionRunEvent[]) => Promise<FusionRunEvent[]>;
}) {
  const encoder = new TextEncoder();
  const id = streamId();
  const created = Math.floor(Date.now() / 1000);

  return new ReadableStream({
    async start(controller) {
      const enqueue = (payload: unknown) => {
        controller.enqueue(encoder.encode(encodeSse(payload)));
      };

      enqueue(
        chunkPayload({
          id,
          created,
          model: options.model,
          delta: { role: "assistant" }
        })
      );

      const events: FusionRunEvent[] = [];
      // The synthesizer streams its answer token-by-token (Vercel AI Gateway nodes). Once
      // any token has been sent we must not re-send the full text at the end.
      let streamedContent = false;
      const canStreamText = !requiresBufferedResponse(options.runInput.response_format);

      try {
        const run = await options.runner(options.runInput, {
          signal: options.signal,
          onEvent: (event) => {
            events.push(event);
            publishRunEvent(event);
            enqueue(
              chunkPayload({
                id,
                created,
                model: options.model,
                fusionEvent: event
              })
            );
          },
          onToken: canStreamText
            ? (delta) => {
                streamedContent = true;
                enqueue(
                  chunkPayload({ id, created, model: options.model, delta: { content: delta } })
                );
              }
            : undefined
        });
        assertResponseFormatSatisfied(run.final, options.runInput.response_format);
        const saved = await options.saveRunRecord(run);
        await options.saveEvents(saved.id, events);
        completeRunEvents(saved.id);
        const completion = openAICompletionFromRun(saved, options.model);
        const toolCalls = saved.metadata.client_tool_calls;

        enqueue(
          chunkPayload({
            id,
            created,
            model: options.model,
            // Already streamed token-by-token → attach metadata only. Otherwise
            // (harness synth, tool calls, or an empty answer) send it in full now.
            delta: toolCalls?.length
              ? { tool_calls: toolCallDeltas(toolCalls) }
              : streamedContent
                ? {}
                : { content: saved.final },
            fusion: completion.fusion
          })
        );
        enqueue(
          chunkPayload({
            id,
            created,
            model: options.model,
            finishReason: toolCalls?.length
              ? "tool_calls"
              : saved.status === "ok"
                ? "stop"
                : "error",
            fusion: completion.fusion
          })
        );
        if (wantsStreamUsage(options.runInput.stream_options)) {
          enqueue(
            chunkPayload({
              id,
              created,
              model: options.model,
              emptyChoices: true,
              usage: openAIUsage(saved.usage),
              fusion: completion.fusion
            })
          );
        }
      } catch (error) {
        failRunEvents(events[0]?.run_id, error);
        const message = errorMessage(error);
        enqueue(
          chunkPayload({
            id,
            created,
            model: options.model,
            delta: { content: `Fusion stream failed: ${message}` },
            finishReason: "error",
            error: {
              type:
                error instanceof FusionConfigurationError
                  ? "configuration_required"
                  : error instanceof FusionBudgetExceededError
                    ? "budget_exceeded"
                    : "runtime_error",
              message
            }
          })
        );
      } finally {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    }
  });
}

export async function handleOpenAIChatCompletion(
  request: Request,
  deps: OpenAIHandlerDeps = {}
) {
  const authError = requireApiAuth(request);
  if (authError) {
    return authError;
  }

  try {
    const body = await request.json();
    const input = OpenAIChatCompletionRequestSchema.parse(body);
    assertOpenAICompatibility(input);
    assertResponseFormatSupported(input.response_format);
    assertSupportedClientTools(input);
    const events: FusionRunEvent[] = [];
    const fusion = mergeActiveGraph(fusionOverrideFromOpenAIRequest(input));
    // Pre-flight, before the stream branch: a capped budget refuses with a
    // real HTTP 402 instead of an in-stream error chunk. The orchestrator
    // re-checks as a backstop for direct callers.
    assertRunWithinBudget([
      ...(fusion?.panel_models ?? []),
      fusion?.judge_model,
      fusion?.outer_model
    ]);
    const agenticFusion = shouldUseAgenticFusion(input);
    const runner = agenticFusion
      ? deps.agenticRunner ?? defaultAgenticRunner
      : deps.directRunner ?? defaultDirectRunner;
    const saveRunRecord = deps.saveRunRecord ?? saveRun;
    const saveEvents = deps.saveEvents ?? saveRunEvents;
    const contextMessages = contextMessagesForOpenAI(input.messages);
    const runInput: RunRequest = {
      model: input.model,
      mode: modeForOpenAIRequest(input.model),
      messages: input.messages,
      context_messages: contextMessages,
      stream: input.stream,
      temperature: input.temperature,
      top_p: input.top_p,
      presence_penalty: input.presence_penalty,
      frequency_penalty: input.frequency_penalty,
      seed: input.seed,
      stop: input.stop,
      max_tokens: input.max_tokens,
      max_completion_tokens: input.max_completion_tokens,
      thread_id: metadataString(input.metadata, "thread_id"),
      parent_run_id: metadataString(input.metadata, "parent_run_id"),
      turn_index: metadataNumber(input.metadata, "turn_index"),
      fusion,
      client_tools: clientFunctionTools(input),
      client_tool_choice: normalizedClientToolChoice(input),
      response_format: input.response_format,
      stream_options: input.stream_options,
      metadata: input.metadata
    };

    if (input.stream) {
      return new Response(
        streamOpenAICompletionLive({
          model: input.model,
          runInput,
          runner,
          // Aborts every upstream model call if the client stops or the
          // connection drops — so a Stop doesn't keep burning Vercel AI Gateway quota.
          signal: request.signal,
          saveRunRecord,
          saveEvents
        }),
        {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive"
          }
        }
      );
    }

    let run: FusionRun;
    try {
      const produced = await runner(runInput, {
          signal: request.signal,
          onEvent: (event) => {
            events.push(event);
            publishRunEvent(event);
          }
        });
      assertResponseFormatSatisfied(produced.final, input.response_format);
      run = await saveRunRecord(produced);
      await saveEvents(run.id, events);
      completeRunEvents(run.id);
    } catch (error) {
      failRunEvents(events[0]?.run_id, error);
      throw error;
    }

    return Response.json(openAICompletionFromRun(run, input.model));
  } catch (error) {
    if (error instanceof FusionConfigurationError) {
      return jsonError("configuration_required", error.message, 503);
    }

    if (error instanceof FusionBudgetExceededError) {
      return jsonError("budget_exceeded", error.message, 402);
    }

    return jsonError(
      "invalid_request_error",
      errorMessage(error),
      400
    );
  }
}
