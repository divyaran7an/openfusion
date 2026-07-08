import { mergeActiveGraph } from "./active-graph.ts";
import { requireApiAuth } from "./auth.ts";
import { FusionBudgetExceededError, FusionConfigurationError } from "./errors.ts";
import { jsonError } from "./http-errors.ts";
import {
  completeRunEvents,
  failRunEvents,
  publishRunEvent,
  streamActiveRunEvents
} from "./run-event-bus.ts";
import { RunRequestSchema, type RunRequest } from "./schemas.ts";
import {
  getRun,
  getRunEvents,
  listRuns,
  listThreadRuns,
  saveRun,
  saveRunEvents
} from "./store.ts";
import type { FusionRun, FusionRunEvent } from "./types.ts";

type Runner = (
  request: RunRequest,
  options: { onEvent?: (event: FusionRunEvent) => void | Promise<void> }
) => Promise<FusionRun>;

export type RunHandlerDeps = {
  runner?: Runner;
  listRunRecords?: () => Promise<FusionRun[]>;
  listThreadRunRecords?: (threadId: string) => Promise<FusionRun[]>;
  getRunRecord?: (id: string) => Promise<FusionRun | undefined>;
  getEventRecords?: (runId: string) => Promise<FusionRunEvent[]>;
  saveRunRecord?: (run: FusionRun) => Promise<FusionRun>;
  saveEvents?: (runId: string, events: FusionRunEvent[]) => Promise<FusionRunEvent[]>;
};

function errorResponse(error: unknown) {
  if (error instanceof FusionConfigurationError) {
    return jsonError("configuration_required", error.message, 503);
  }

  if (error instanceof FusionBudgetExceededError) {
    return jsonError("budget_exceeded", error.message, 402);
  }

  if (error instanceof Error) {
    return jsonError("bad_request", error.message, 400);
  }

  return jsonError("unexpected_error", "Unexpected Fusion run failure.", 500);
}

function notFound(id: string) {
  return jsonError("not_found", `No run exists with id ${id}.`, 404);
}

function afterSequenceFor(request: Request) {
  const url = new URL(request.url);
  const raw =
    url.searchParams.get("after") ??
    request.headers.get("last-event-id") ??
    request.headers.get("Last-Event-ID");
  const value = raw ? Number.parseInt(raw, 10) : -1;
  return Number.isInteger(value) && value >= 0 ? value : -1;
}

export async function handleRunsList(request: Request, deps: RunHandlerDeps = {}) {
  const authError = requireApiAuth(request);
  if (authError) {
    return authError;
  }

  const threadId = new URL(request.url).searchParams.get("thread_id")?.trim();

  return Response.json({
    object: "list",
    ...(threadId ? { thread_id: threadId } : {}),
    data: threadId
      ? await (deps.listThreadRunRecords ?? listThreadRuns)(threadId)
      : await (deps.listRunRecords ?? listRuns)()
  });
}

export async function handleRunCreate(request: Request, deps: RunHandlerDeps = {}) {
  const authError = requireApiAuth(request);
  if (authError) {
    return authError;
  }

  const events: FusionRunEvent[] = [];

  try {
    const input = RunRequestSchema.parse(await request.json());
    // The native path runs the same active graph as /v1/*. An explicit
    // request-level fusion override with panel models still wins.
    input.fusion = mergeActiveGraph(input.fusion ?? undefined);
    const runner = deps.runner;
    if (!runner) {
      throw new Error("Fusion run handler requires a configured runner.");
    }

    const run = await runner(input, {
      onEvent: (event) => {
        events.push(event);
        publishRunEvent(event);
      }
    });
    const saved = await (deps.saveRunRecord ?? saveRun)(run);
    await (deps.saveEvents ?? saveRunEvents)(saved.id, events);
    completeRunEvents(saved.id);

    return Response.json(saved, { status: saved.status === "ok" ? 200 : 502 });
  } catch (error) {
    failRunEvents(events[0]?.run_id, error);
    return errorResponse(error);
  }
}

export async function handleRunGet(
  request: Request,
  id: string,
  deps: RunHandlerDeps = {}
) {
  const authError = requireApiAuth(request);
  if (authError) {
    return authError;
  }

  const run = await (deps.getRunRecord ?? getRun)(id);
  if (!run) {
    return notFound(id);
  }

  return Response.json(run);
}

export async function handleRunEventsGet(
  request: Request,
  id: string,
  deps: RunHandlerDeps = {}
) {
  const authError = requireApiAuth(request);
  if (authError) {
    return authError;
  }

  const wantsStream =
    new URL(request.url).searchParams.get("stream") === "1" ||
    request.headers.get("accept")?.includes("text/event-stream");
  const afterSequence = afterSequenceFor(request);

  if (wantsStream) {
    const activeStream = streamActiveRunEvents(id, { afterSequence });
    if (activeStream) {
      return new Response(activeStream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive"
        }
      });
    }
  }

  const run = await (deps.getRunRecord ?? getRun)(id);
  if (!run) {
    return notFound(id);
  }

  const events = await (deps.getEventRecords ?? getRunEvents)(id);

  if (!wantsStream) {
    return Response.json({
      object: "list",
      run_id: id,
      data: events
    });
  }

  return new Response(streamEvents(events, afterSequence), {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    }
  });
}

function streamEvents(events: FusionRunEvent[], afterSequence = -1) {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        if (event.sequence <= afterSequence) {
          continue;
        }
        controller.enqueue(encoder.encode(`event: ${event.type}\n`));
        controller.enqueue(encoder.encode(`id: ${event.sequence}\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(encoder.encode("event: done\n"));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
}
