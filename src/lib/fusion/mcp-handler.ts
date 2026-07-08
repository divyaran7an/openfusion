import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { mergeActiveGraph } from "./active-graph.ts";
import { requireApiAuth } from "./auth.ts";
import { FusionBudgetExceededError, FusionConfigurationError } from "./errors.ts";
import {
  completeRunEvents,
  failRunEvents,
  publishRunEvent
} from "./run-event-bus.ts";
import { shortId } from "./ids.ts";
import type { ChatMessage, RunRequest } from "./schemas.ts";
import { listThreadRuns, saveRun, saveRunEvents } from "./store.ts";
import type { FusionRun, FusionRunEvent } from "./types.ts";

/**
 * The first-party MCP server: the council as a single `deep_consensus` tool
 * over stateless Streamable HTTP, served by the engine that is already
 * running. Register once, user-scope, and every MCP-capable agent session can
 * fan a question out to the active graph:
 *
 *   claude mcp add --transport http --scope user openfusion \
 *     http://127.0.0.1:3000/api/mcp
 *
 * Council runs routinely take minutes; clients with short tool timeouts
 * should raise them (Claude Code: MCP_TOOL_TIMEOUT). When the client sends a
 * progress token, fusion run events are forwarded as progress notifications
 * to keep the stream alive.
 */

type Runner = (
  request: RunRequest,
  options: {
    onEvent?: (event: FusionRunEvent) => void | Promise<void>;
    signal?: AbortSignal;
  }
) => Promise<FusionRun>;

export type McpHandlerDeps = {
  runner?: Runner;
  saveRunRecord?: (run: FusionRun) => Promise<FusionRun>;
  saveEvents?: (runId: string, events: FusionRunEvent[]) => Promise<FusionRunEvent[]>;
  listThreadRunRecords?: (threadId: string) => Promise<FusionRun[]>;
};

// Direct, not agentic: the MCP client is already the agent. One deterministic
// council pass — panel, optional judge, synthesizer — and the answer comes back.
async function defaultRunner(...args: Parameters<Runner>) {
  const { runFusion } = await import("./orchestrator.ts");
  return runFusion(...args);
}

export const DEEP_CONSENSUS_INPUT_SHAPE = {
  question: z
    .string()
    .min(1)
    .describe("The question or task to put before the council."),
  system_prompt: z
    .string()
    .optional()
    .describe("Optional system framing prepended to the council run."),
  thread_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Continue a prior council conversation: pass the thread_id returned by an " +
        "earlier deep_consensus call and the council sees the previous turns as " +
        "context. Omit to start a fresh thread (every result returns its thread_id)."
    )
};

/**
 * The tool's structured output is a stable, additive-only contract: fields may
 * be added over time, but existing fields are never renamed, removed, or
 * repurposed — agents built against an older shape keep working. Enforced by
 * a schema-freeze test; extend deliberately.
 *
 * The advertised schema must stay OPEN (`z.looseObject`, not a closed object).
 * The MCP spec tells clients to validate structured results against the
 * declared output schema; with `additionalProperties: false` a client holding
 * a pre-upgrade schema would reject any result that gained a new field —
 * which would turn every additive change into a breaking one.
 */
export const DEEP_CONSENSUS_OUTPUT_SHAPE = {
  run_id: z.string(),
  thread_id: z.string(),
  turn_index: z.number(),
  status: z.string(),
  degraded: z.boolean(),
  panel_size: z.number(),
  panel_models: z.array(z.string()),
  judge_model: z.string().optional(),
  outer_model: z.string(),
  cost_usd: z.number(),
  cost_source: z.string().optional(),
  latency_ms_end_to_end: z.number()
};

export type DeepConsensusResult = {
  run_id: string;
  thread_id: string;
  turn_index: number;
  status: string;
  degraded: boolean;
  panel_size: number;
  panel_models: string[];
  judge_model?: string;
  outer_model: string;
  cost_usd: number;
  cost_source?: string;
  latency_ms_end_to_end: number;
};

function structuredFromRun(
  run: FusionRun,
  thread: { threadId: string; turnIndex: number }
): DeepConsensusResult {
  return {
    run_id: run.id,
    thread_id: run.metadata.thread_id ?? thread.threadId,
    turn_index: run.metadata.turn_index ?? thread.turnIndex,
    status: run.status,
    degraded: run.degraded,
    panel_size: run.metadata.panel_size,
    panel_models: run.metadata.panel_models,
    ...(run.metadata.judge_model ? { judge_model: run.metadata.judge_model } : {}),
    outer_model: run.metadata.outer_model,
    cost_usd: run.cost_usd,
    ...(run.metadata.cost_source ? { cost_source: run.metadata.cost_source } : {}),
    latency_ms_end_to_end: run.latency_ms.end_to_end
  };
}

/** Prior thread turns folded in as context, newest last, capped to keep prompts sane. */
const MAX_CONTEXT_TURNS = 12;

function contextFromThreadRuns(runs: FusionRun[]): ChatMessage[] {
  return runs
    .filter((run) => run.status === "ok" && run.final.trim())
    .slice(-MAX_CONTEXT_TURNS)
    .flatMap((run) => [
      { role: "user" as const, content: run.prompt },
      { role: "assistant" as const, content: run.final }
    ]);
}

/**
 * Run the council for an MCP tool call. Exported separately so tests exercise
 * the tool without a JSON-RPC round trip. Failures come back as in-band tool
 * errors (`isError`), the MCP convention for tool-execution problems.
 *
 * Threading: every call belongs to a thread. A fresh call mints a thread id
 * and returns it; a call with `thread_id` replays that thread's earlier
 * prompts and answers as conversation context, so follow-ups work the way
 * they do for chat clients that resend their transcript.
 */
export async function runDeepConsensus(
  args: { question: string; system_prompt?: string; thread_id?: string },
  deps: McpHandlerDeps = {},
  options: {
    signal?: AbortSignal;
    notify?: (progress: number, message: string) => Promise<void>;
  } = {}
): Promise<{ text: string; structured?: DeepConsensusResult; isError: boolean }> {
  const events: FusionRunEvent[] = [];
  try {
    const fusion = mergeActiveGraph(undefined);
    const requestedThread = args.thread_id?.trim();
    const threadId = requestedThread || shortId("thr");
    const priorRuns = requestedThread
      ? await (deps.listThreadRunRecords ?? listThreadRuns)(requestedThread)
      : [];
    const turnIndex =
      priorRuns.length > 0
        ? (priorRuns[priorRuns.length - 1].metadata.turn_index ?? priorRuns.length - 1) + 1
        : 0;
    const contextMessages = contextFromThreadRuns(priorRuns);
    const runInput: RunRequest = {
      mode: "openfusion",
      messages: [
        ...(args.system_prompt?.trim()
          ? [{ role: "system" as const, content: args.system_prompt }]
          : []),
        { role: "user" as const, content: args.question }
      ],
      context_messages: contextMessages.length > 0 ? contextMessages : undefined,
      thread_id: threadId,
      parent_run_id: priorRuns[priorRuns.length - 1]?.id,
      turn_index: turnIndex,
      fusion
    };

    let progress = 0;
    const run = await (deps.runner ?? defaultRunner)(runInput, {
      signal: options.signal,
      onEvent: async (event) => {
        events.push(event);
        publishRunEvent(event);
        progress += 1;
        await options.notify?.(progress, event.type).catch(() => {
          // A dropped progress notification must never fail the run.
        });
      }
    });

    const saved = await (deps.saveRunRecord ?? saveRun)(run);
    await (deps.saveEvents ?? saveRunEvents)(saved.id, events);
    completeRunEvents(saved.id);

    const thread = { threadId, turnIndex };
    if (saved.status !== "ok") {
      return {
        text: saved.final,
        structured: structuredFromRun(saved, thread),
        isError: true
      };
    }
    return {
      text: saved.final,
      structured: structuredFromRun(saved, thread),
      isError: false
    };
  } catch (error) {
    failRunEvents(events[0]?.run_id, error);
    const message =
      error instanceof FusionConfigurationError || error instanceof FusionBudgetExceededError
        ? error.message
        : error instanceof Error
          ? `Fusion run failed: ${error.message}`
          : "Unexpected Fusion run failure.";
    return { text: message, isError: true };
  }
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8")
    ) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const SERVER_INFO = { name: "openfusion", version: packageVersion() };

function methodNotAllowed() {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message:
          "Method not allowed. OpenFusion's MCP endpoint is stateless: POST JSON-RPC to /api/mcp."
      },
      id: null
    },
    { status: 405, headers: { Allow: "POST" } }
  );
}

/**
 * Stateless Streamable HTTP entry point. Per the MCP SDK's session model, a
 * fresh server + transport pair is created for every request so concurrent
 * clients can never leak state into each other.
 */
export async function handleMcpRequest(
  request: Request,
  deps: McpHandlerDeps = {}
): Promise<Response> {
  const authError = requireApiAuth(request);
  if (authError) {
    return authError;
  }

  if (request.method !== "POST") {
    return methodNotAllowed();
  }

  const server = new McpServer(SERVER_INFO);
  server.registerTool(
    "deep_consensus",
    {
      title: "Deep consensus",
      description:
        "Run the OpenFusion council on a question: panel models answer in parallel, " +
        "an optional judge compares the answers, and a synthesizer writes the final " +
        "response. Returns the synthesized answer with run metadata, including a " +
        "thread_id — pass it back on the next call to ask a follow-up with the " +
        "earlier turns as context. Council runs can take minutes — use a generous " +
        "tool timeout.",
      inputSchema: DEEP_CONSENSUS_INPUT_SHAPE,
      // Open object, not a raw shape: raw shapes compile to
      // additionalProperties:false, which breaks additive evolution for any
      // client validating against a previously fetched schema.
      outputSchema: z.looseObject(DEEP_CONSENSUS_OUTPUT_SHAPE)
    },
    async (args, extra) => {
      const progressToken = extra._meta?.progressToken;
      const result = await runDeepConsensus(args, deps, {
        signal: extra.signal,
        notify:
          progressToken === undefined
            ? undefined
            : async (progress, message) => {
                await extra.sendNotification({
                  method: "notifications/progress",
                  params: { progressToken, progress, message }
                });
              }
      });
      return {
        content: [{ type: "text", text: result.text }],
        ...(result.structured ? { structuredContent: result.structured } : {}),
        ...(result.isError ? { isError: true } : {})
      };
    }
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });
  await server.connect(transport);
  // The response body may still be streaming the tool result after this
  // resolves, so the transport is not closed here; the per-request pair is
  // garbage-collected with the response.
  return transport.handleRequest(request);
}
