import { z } from "zod";

import { requireApiAuth } from "./auth.ts";
import {
  OpenAIChatCompletionChunkSchema,
  OpenAIChatCompletionResponseSchema,
  type ChatMessage,
  type OpenAIChatCompletionChunk,
  type OpenAIChatCompletionRequest,
  type OpenAIChatCompletionResponse,
  type OpenAIClientToolCall
} from "./schemas.ts";
import {
  handleOpenAIChatCompletion,
  type OpenAIHandlerDeps
} from "./openai-handler.ts";
import { getRun } from "./store.ts";
import type { FusionRun } from "./types.ts";

type RawObject = Record<string, unknown>;

function nullishOptional<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === null ? undefined : value), schema.optional());
}

const ResponsesRequestSchema = z.object({
  model: z.string().min(1),
  input: z.unknown(),
  instructions: nullishOptional(z.string().min(1)),
  stream: nullishOptional(z.boolean()),
  temperature: nullishOptional(z.number().min(0).max(2)),
  top_p: nullishOptional(z.number().min(0).max(1)),
  parallel_tool_calls: nullishOptional(z.boolean()),
  max_output_tokens: nullishOptional(z.number().int().positive()),
  previous_response_id: nullishOptional(z.string().min(1)),
  metadata: nullishOptional(z.record(z.string(), z.unknown())),
  tools: nullishOptional(z.array(z.record(z.string(), z.unknown()))),
  tool_choice: nullishOptional(z.unknown()),
  text: nullishOptional(
    z
      .object({
        format: z.unknown().optional()
      })
      .passthrough()
  ),
  reasoning: nullishOptional(z.record(z.string(), z.unknown())),
  store: nullishOptional(z.boolean()),
  user: nullishOptional(z.string())
}).passthrough();

type ResponsesRequest = z.infer<typeof ResponsesRequestSchema>;

export type ResponsesHandlerDeps = OpenAIHandlerDeps & {
  getRunRecord?: (id: string) => Promise<FusionRun | undefined>;
};

function jsonError(type: string, message: string, status: number) {
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

function isRecord(value: unknown): value is RawObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromPart(part: RawObject, path: string) {
  const type = typeof part.type === "string" ? part.type : "unknown";
  if (type === "input_text" || type === "output_text" || type === "text") {
    return typeof part.text === "string" ? part.text : "";
  }

  throw new Error(
    `OpenFusion /v1/responses currently supports text input only. ${path} has type "${type}".`
  );
}

function chatContentFromResponsesContent(content: unknown, path: string): ChatMessage["content"] {
  if (typeof content === "string" || content === null) {
    return content ?? "";
  }

  if (!Array.isArray(content)) {
    throw new Error(`${path} must be a string or an array of text content parts.`);
  }

  return content.map((part, index) => {
    if (!isRecord(part)) {
      throw new Error(`${path}[${index}] must be an object.`);
    }
    return {
      type: "text",
      text: textFromPart(part, `${path}[${index}]`)
    };
  });
}

function responseItemToChatMessage(item: unknown, index: number): ChatMessage | undefined {
  if (!isRecord(item)) {
    throw new Error(`input[${index}] must be an object.`);
  }

  const type = typeof item.type === "string" ? item.type : undefined;
  const role = typeof item.role === "string" ? item.role : undefined;

  if (
    role === "developer" ||
    role === "system" ||
    role === "user" ||
    role === "assistant" ||
    role === "tool"
  ) {
    return {
      role,
      content: chatContentFromResponsesContent(item.content ?? "", `input[${index}].content`),
      ...(typeof item.name === "string" ? { name: item.name } : {}),
      ...(typeof item.tool_call_id === "string" ? { tool_call_id: item.tool_call_id } : {})
    };
  }

  if (type === "message") {
    const messageRole = typeof item.role === "string" ? item.role : "assistant";
    if (
      messageRole !== "developer" &&
      messageRole !== "system" &&
      messageRole !== "user" &&
      messageRole !== "assistant"
    ) {
      throw new Error(`input[${index}].role "${messageRole}" is not supported.`);
    }
    return {
      role: messageRole,
      content: chatContentFromResponsesContent(item.content ?? "", `input[${index}].content`)
    };
  }

  if (type === "function_call") {
    const name = typeof item.name === "string" ? item.name : "";
    if (!name) {
      throw new Error(`input[${index}].name is required for function_call items.`);
    }
    const callId =
      typeof item.call_id === "string" && item.call_id.trim()
        ? item.call_id
        : `call_${index}`;
    return {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: callId,
          type: "function",
          function: {
            name,
            arguments:
              typeof item.arguments === "string"
                ? item.arguments
                : JSON.stringify(item.arguments ?? {})
          }
        }
      ]
    };
  }

  if (type === "function_call_output") {
    const callId = typeof item.call_id === "string" ? item.call_id : "";
    if (!callId) {
      throw new Error(`input[${index}].call_id is required for function_call_output items.`);
    }
    return {
      role: "tool",
      tool_call_id: callId,
      content:
        typeof item.output === "string"
          ? item.output
          : JSON.stringify(item.output ?? "")
    };
  }

  // Replayable Responses output can contain reasoning or hosted-tool trace items.
  // They have no Chat Completions equivalent here, so keep the text/tool
  // transcript and ignore trace-only records.
  if (
    type === "reasoning" ||
    type === "web_search_call" ||
    type === "file_search_call" ||
    type === "code_interpreter_call" ||
    type === "computer_call" ||
    type === "mcp_call" ||
    type === "custom_tool_call" ||
    type === "image_generation_call"
  ) {
    return undefined;
  }

  throw new Error(`Unsupported /v1/responses input item type "${type ?? "unknown"}".`);
}

function messagesFromInput(input: unknown, instructions: string | undefined): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (instructions) {
    messages.push({ role: "developer", content: instructions });
  }

  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    input.forEach((item, index) => {
      const message = responseItemToChatMessage(item, index);
      if (message) {
        messages.push(message);
      }
    });
  } else {
    throw new Error("/v1/responses input must be a string or an array of input items.");
  }

  if (!messages.some((message) => message.role === "user")) {
    throw new Error("/v1/responses input needs at least one user message.");
  }

  return messages;
}

function runIdCandidatesFromResponseId(responseId: string) {
  const trimmed = responseId.trim();
  const candidates = new Set<string>([trimmed]);

  if (trimmed.startsWith("resp_")) {
    const bare = trimmed.slice("resp_".length);
    candidates.add(bare);
    candidates.add(bare.startsWith("run_") ? bare : `run_${bare}`);
  }

  if (trimmed.startsWith("chatcmpl_")) {
    const bare = trimmed.slice("chatcmpl_".length);
    candidates.add(bare);
    candidates.add(bare.startsWith("run_") ? bare : `run_${bare}`);
  }

  return [...candidates];
}

async function resolvePreviousRun(
  responseId: string | undefined,
  getRunRecord: (id: string) => Promise<FusionRun | undefined>
) {
  if (!responseId) {
    return undefined;
  }

  for (const candidate of runIdCandidatesFromResponseId(responseId)) {
    const run = await getRunRecord(candidate);
    if (run) {
      return run;
    }
  }

  throw new Error(`previous_response_id "${responseId}" does not match a saved OpenFusion response.`);
}

function messagesFromPreviousRun(run: FusionRun): ChatMessage[] {
  const toolCalls = run.metadata.client_tool_calls;
  return [
    { role: "user", content: run.prompt },
    {
      role: "assistant",
      content: toolCalls?.length ? null : run.final,
      ...(toolCalls?.length ? { tool_calls: toolCalls } : {})
    }
  ];
}

function chatToolFromResponsesTool(tool: RawObject) {
  if (tool.type === "function") {
    if (isRecord(tool.function)) {
      return tool;
    }

    if (typeof tool.name === "string" && tool.name.trim()) {
      return {
        type: "function",
        function: {
          name: tool.name,
          ...(typeof tool.description === "string" ? { description: tool.description } : {}),
          ...(isRecord(tool.parameters) ? { parameters: tool.parameters } : {})
        }
      };
    }
  }

  if (
    tool.type === "openrouter:fusion" ||
    tool.type === "fusion:fusion" ||
    tool.type === "openrouter:web_search" ||
    tool.type === "openrouter:web_fetch"
  ) {
    return tool;
  }

  throw new Error(
    `Unsupported /v1/responses tool "${String(tool.type ?? "unknown")}". OpenFusion accepts function tools plus OpenRouter Fusion/web server tools.`
  );
}

function toolsFromResponsesTools(tools: ResponsesRequest["tools"]) {
  return tools?.map(chatToolFromResponsesTool);
}

function toolChoiceFromResponsesToolChoice(toolChoice: unknown) {
  if (
    toolChoice === undefined ||
    toolChoice === "auto" ||
    toolChoice === "none" ||
    toolChoice === "required"
  ) {
    return toolChoice;
  }

  if (!isRecord(toolChoice)) {
    return toolChoice;
  }

  if (toolChoice.type === "function" && typeof toolChoice.name === "string") {
    return {
      type: "function",
      function: {
        name: toolChoice.name
      }
    };
  }

  return toolChoice;
}

function responseFormatFromText(text: ResponsesRequest["text"]) {
  const format = text?.format;
  if (format === undefined) {
    return undefined;
  }

  if (!isRecord(format)) {
    throw new Error("text.format must be an object.");
  }

  if (format.type === "text") {
    return { type: "text" as const };
  }

  if (format.type === "json_object") {
    return { type: "json_object" as const };
  }

  if (format.type === "json_schema") {
    return {
      type: "json_schema" as const,
      json_schema: {
        name: typeof format.name === "string" ? format.name : "response",
        ...(typeof format.description === "string" ? { description: format.description } : {}),
        ...(isRecord(format.schema) ? { schema: format.schema } : {}),
        ...(typeof format.strict === "boolean" || format.strict === null
          ? { strict: format.strict }
          : {})
      }
    };
  }

  throw new Error(`Unsupported text.format type "${String(format.type ?? "unknown")}".`);
}

async function responsesRequestToChatRequest(
  input: ResponsesRequest,
  getRunRecord: (id: string) => Promise<FusionRun | undefined>
): Promise<OpenAIChatCompletionRequest> {
  const previousRun = await resolvePreviousRun(input.previous_response_id, getRunRecord);
  const metadata = {
    ...(input.metadata ?? {}),
    ...(previousRun ? { parent_run_id: previousRun.id } : {})
  };
  const currentMessages = messagesFromInput(input.input, input.instructions);
  const previousMessages = previousRun ? messagesFromPreviousRun(previousRun) : [];
  const messages =
    previousMessages.length > 0 && currentMessages[0]?.role === "developer"
      ? [currentMessages[0], ...previousMessages, ...currentMessages.slice(1)]
      : [...previousMessages, ...currentMessages];

  return {
    model: input.model,
    messages,
    stream: input.stream,
    temperature: input.temperature,
    top_p: input.top_p,
    parallel_tool_calls: input.parallel_tool_calls,
    max_completion_tokens: input.max_output_tokens,
    tools: toolsFromResponsesTools(input.tools),
    tool_choice: toolChoiceFromResponsesToolChoice(input.tool_choice),
    response_format: responseFormatFromText(input.text),
    reasoning: input.reasoning,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined
  };
}

function responseIdFromChatId(chatId: string) {
  return `resp_${chatId.replace(/^chatcmpl_/, "")}`;
}

function outputMessageFromText(responseId: string, text: string, status = "completed") {
  return {
    id: `msg_${responseId.replace(/^resp_/, "")}`,
    type: "message",
    status,
    role: "assistant",
    content: [
      {
        type: "output_text",
        text,
        annotations: []
      }
    ]
  };
}

function outputFunctionCallFromToolCall(toolCall: OpenAIClientToolCall) {
  return {
    id: `fc_${toolCall.id.replace(/^call_/, "")}`,
    type: "function_call",
    status: "completed",
    call_id: toolCall.id,
    name: toolCall.function.name,
    arguments: toolCall.function.arguments
  };
}

function responseUsageFromChat(usage: OpenAIChatCompletionResponse["usage"]) {
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens
  };
}

function responseFromChatCompletion(
  completion: OpenAIChatCompletionResponse,
  original: ResponsesRequest
) {
  const responseId = responseIdFromChatId(completion.id);
  const choice = completion.choices[0];
  const message = choice?.message;
  const text = message?.content ?? "";
  const toolCalls = message?.tool_calls ?? [];
  const output =
    toolCalls.length > 0
      ? toolCalls.map(outputFunctionCallFromToolCall)
      : [outputMessageFromText(responseId, text)];

  return {
    id: responseId,
    object: "response",
    created_at: completion.created,
    status: choice?.finish_reason === "error" ? "failed" : "completed",
    model: completion.model,
    output,
    output_text: toolCalls.length > 0 ? "" : text,
    usage: responseUsageFromChat(completion.usage),
    error: choice?.finish_reason === "error"
      ? {
          code: "runtime_error",
          message: text || "OpenFusion response failed."
        }
      : null,
    incomplete_details: null,
    instructions: original.instructions ?? null,
    metadata: original.metadata ?? {},
    fusion: completion.fusion
  };
}

function encodeResponseEvent(type: string, payload: RawObject) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function parseChatSseData(event: string) {
  const data = event
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  return data || undefined;
}

function mergeToolCallDelta(
  toolCalls: Map<number, OpenAIClientToolCall>,
  delta: unknown
) {
  if (!Array.isArray(delta)) {
    return;
  }

  for (const entry of delta) {
    if (!isRecord(entry) || typeof entry.index !== "number") {
      continue;
    }
    const existing = toolCalls.get(entry.index);
    const fn = isRecord(entry.function) ? entry.function : {};
    toolCalls.set(entry.index, {
      id:
        typeof entry.id === "string"
          ? entry.id
          : existing?.id ?? `call_${entry.index}`,
      type: "function",
      function: {
        name:
          typeof fn.name === "string"
            ? fn.name
            : existing?.function.name ?? "",
        arguments:
          typeof fn.arguments === "string"
            ? fn.arguments
            : existing?.function.arguments ?? ""
      }
    });
  }
}

function streamResponsesFromChat(
  chatStream: ReadableStream<Uint8Array>,
  model: string
) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const responseId = `resp_live_${crypto.randomUUID().replaceAll("-", "")}`;
  const messageId = `msg_${responseId.replace(/^resp_/, "")}`;
  const createdAt = Math.floor(Date.now() / 1000);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (type: string, payload: RawObject) => {
        controller.enqueue(encoder.encode(encodeResponseEvent(type, payload)));
      };
      const enqueueDone = () => {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      };

      const reader = chatStream.getReader();
      const toolCalls = new Map<number, OpenAIClientToolCall>();
      let buffer = "";
      let text = "";
      let messageStarted = false;
      let contentStarted = false;
      let failed: { code: string; message: string } | null = null;
      let usage: ReturnType<typeof responseUsageFromChat> | null = null;
      let fusion: unknown;

      enqueue("response.created", {
        response: {
          id: responseId,
          object: "response",
          created_at: createdAt,
          status: "in_progress",
          model,
          output: [],
          output_text: "",
          usage: null,
          error: null,
          incomplete_details: null,
          metadata: {}
        }
      });

      const ensureMessage = () => {
        if (!messageStarted) {
          messageStarted = true;
          enqueue("response.output_item.added", {
            response_id: responseId,
            output_index: 0,
            item: outputMessageFromText(responseId, "", "in_progress")
          });
        }
        if (!contentStarted) {
          contentStarted = true;
          enqueue("response.content_part.added", {
            response_id: responseId,
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] }
          });
        }
      };

      const finishText = () => {
        if (!messageStarted && toolCalls.size === 0) {
          ensureMessage();
        }
        if (contentStarted) {
          enqueue("response.output_text.done", {
            response_id: responseId,
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            text
          });
          enqueue("response.content_part.done", {
            response_id: responseId,
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text, annotations: [] }
          });
        }
        if (messageStarted) {
          enqueue("response.output_item.done", {
            response_id: responseId,
            output_index: 0,
            item: outputMessageFromText(responseId, text)
          });
        }
      };

      const emitToolCalls = () => {
        let index = 0;
        for (const [, toolCall] of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
          const item = outputFunctionCallFromToolCall(toolCall);
          enqueue("response.output_item.added", {
            response_id: responseId,
            output_index: index,
            item
          });
          enqueue("response.output_item.done", {
            response_id: responseId,
            output_index: index,
            item
          });
          index += 1;
        }
      };

      const completedResponse = (status: "completed" | "failed") => {
        const output = toolCalls.size > 0
          ? [...toolCalls.entries()]
              .sort(([a], [b]) => a - b)
              .map(([, toolCall]) => outputFunctionCallFromToolCall(toolCall))
          : [outputMessageFromText(responseId, text)];

        return {
          id: responseId,
          object: "response",
          created_at: createdAt,
          status,
          model,
          output,
          output_text: toolCalls.size > 0 ? "" : text,
          usage,
          error: failed,
          incomplete_details: null,
          metadata: {},
          ...(fusion ? { fusion } : {})
        };
      };

      const handleEvent = (event: string) => {
        const data = parseChatSseData(event);
        if (!data || data === "[DONE]") {
          return;
        }

        const parsed = OpenAIChatCompletionChunkSchema.parse(JSON.parse(data));
        if (parsed.usage) {
          usage = responseUsageFromChat(parsed.usage);
        }
        if (parsed.fusion) {
          fusion = parsed.fusion;
        }
        if (parsed.error) {
          failed = {
            code: parsed.error.type,
            message: parsed.error.message
          };
        }

        for (const choice of parsed.choices) {
          if (choice.delta.content) {
            ensureMessage();
            text += choice.delta.content;
            enqueue("response.output_text.delta", {
              response_id: responseId,
              item_id: messageId,
              output_index: 0,
              content_index: 0,
              delta: choice.delta.content
            });
          }
          if (choice.delta.tool_calls) {
            mergeToolCallDelta(toolCalls, choice.delta.tool_calls);
          }
          if (choice.finish_reason === "error" && !failed) {
            failed = {
              code: "runtime_error",
              message: text || "OpenFusion response failed."
            };
          }
        }
      };

      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          buffer += decoder.decode(chunk.value, { stream: true });
          while (buffer.includes("\n\n")) {
            const index = buffer.indexOf("\n\n");
            const event = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            handleEvent(event);
          }
        }
        if (buffer.trim()) {
          handleEvent(buffer);
        }

        if (toolCalls.size > 0) {
          emitToolCalls();
        } else {
          finishText();
        }

        if (failed) {
          enqueue("response.failed", { response: completedResponse("failed") });
        } else {
          enqueue("response.completed", { response: completedResponse("completed") });
        }
        enqueueDone();
      } catch (error) {
        failed = {
          code: "runtime_error",
          message: error instanceof Error ? error.message : "OpenFusion response stream failed."
        };
        enqueue("response.failed", { response: completedResponse("failed") });
        enqueueDone();
      } finally {
        controller.close();
      }
    }
  });
}

function chatRequestFromResponsesRequest(
  request: Request,
  input: OpenAIChatCompletionRequest
) {
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  return new Request("http://127.0.0.1/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify(input),
    signal: request.signal
  });
}

export async function handleOpenAIResponse(
  request: Request,
  deps: ResponsesHandlerDeps = {}
) {
  const authError = requireApiAuth(request);
  if (authError) {
    return authError;
  }

  try {
    const raw = await request.json();
    const input = ResponsesRequestSchema.parse(raw);
    const chatRequest = await responsesRequestToChatRequest(input, deps.getRunRecord ?? getRun);
    const upstream = await handleOpenAIChatCompletion(
      chatRequestFromResponsesRequest(request, chatRequest),
      deps
    );

    if (!upstream.ok) {
      return upstream;
    }

    if (input.stream) {
      if (!upstream.body) {
        throw new Error("OpenFusion stream response had no body.");
      }
      return new Response(streamResponsesFromChat(upstream.body, input.model), {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive"
        }
      });
    }

    const completion = OpenAIChatCompletionResponseSchema.parse(await upstream.json());
    return Response.json(responseFromChatCompletion(completion, input));
  } catch (error) {
    return jsonError(
      "invalid_request_error",
      error instanceof Error ? error.message : "Invalid Responses request.",
      400
    );
  }
}
