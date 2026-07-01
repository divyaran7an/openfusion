import type { FusionRunEvent } from "./types.ts";

type Subscriber = {
  afterSequence: number;
  controller: ReadableStreamDefaultController<Uint8Array>;
};

type ActiveRunEvents = {
  completed: boolean;
  events: FusionRunEvent[];
  subscribers: Set<Subscriber>;
  cleanup?: ReturnType<typeof setTimeout>;
};

type FusionEventBusGlobal = typeof globalThis & {
  __fusionActiveRunEvents?: Map<string, ActiveRunEvents>;
};

const globalForFusion = globalThis as FusionEventBusGlobal;
const encoder = new TextEncoder();
const cleanupDelayMs = 30_000;

function activeRuns() {
  if (!globalForFusion.__fusionActiveRunEvents) {
    globalForFusion.__fusionActiveRunEvents = new Map();
  }
  return globalForFusion.__fusionActiveRunEvents;
}

function activeRun(runId: string) {
  const runs = activeRuns();
  const existing = runs.get(runId);
  if (existing) {
    if (existing.cleanup) {
      clearTimeout(existing.cleanup);
      existing.cleanup = undefined;
    }
    return existing;
  }

  const entry: ActiveRunEvents = {
    completed: false,
    events: [],
    subscribers: new Set()
  };
  runs.set(runId, entry);
  return entry;
}

function encodeSse(event: string, data: unknown, id?: string | number) {
  return encoder.encode(
    `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  );
}

function send(subscriber: Subscriber, chunk: Uint8Array) {
  try {
    subscriber.controller.enqueue(chunk);
    return true;
  } catch {
    return false;
  }
}

function sendDone(subscriber: Subscriber) {
  send(subscriber, encoder.encode("event: done\ndata: [DONE]\n\n"));
  try {
    subscriber.controller.close();
  } catch {
  }
}

function scheduleCleanup(runId: string, entry: ActiveRunEvents) {
  entry.cleanup = setTimeout(() => {
    activeRuns().delete(runId);
  }, cleanupDelayMs);
  entry.cleanup.unref?.();
}

export function publishRunEvent(event: FusionRunEvent) {
  const entry = activeRun(event.run_id);
  if (!entry.events.some((existing) => existing.sequence === event.sequence)) {
    entry.events.push(event);
    entry.events.sort((left, right) => left.sequence - right.sequence);
  }

  const chunk = encodeSse(event.type, event, event.sequence);
  for (const subscriber of entry.subscribers) {
    if (event.sequence > subscriber.afterSequence && !send(subscriber, chunk)) {
      entry.subscribers.delete(subscriber);
    }
  }
}

export function completeRunEvents(runId: string) {
  const entry = activeRuns().get(runId);
  if (!entry) {
    return;
  }

  entry.completed = true;
  for (const subscriber of entry.subscribers) {
    sendDone(subscriber);
  }
  entry.subscribers.clear();
  scheduleCleanup(runId, entry);
}

export function failRunEvents(runId: string | undefined, error: unknown) {
  if (!runId) {
    return;
  }

  const entry = activeRuns().get(runId);
  if (!entry) {
    return;
  }

  const message = error instanceof Error ? error.message : "Fusion run failed.";
  const chunk = encodeSse("run.error", {
    object: "fusion.run.error",
    run_id: runId,
    error: {
      type: "runtime_error",
      message
    }
  });

  entry.completed = true;
  for (const subscriber of entry.subscribers) {
    send(subscriber, chunk);
    sendDone(subscriber);
  }
  entry.subscribers.clear();
  scheduleCleanup(runId, entry);
}

export function streamActiveRunEvents(
  runId: string,
  options: { afterSequence?: number } = {}
) {
  const entry = activeRuns().get(runId);
  if (!entry) {
    return undefined;
  }

  const afterSequence = options.afterSequence ?? -1;

  let subscriber: Subscriber | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      subscriber = { afterSequence, controller };
      for (const event of entry.events) {
        if (event.sequence > afterSequence) {
          controller.enqueue(encodeSse(event.type, event, event.sequence));
        }
      }

      if (entry.completed) {
        sendDone(subscriber);
        return;
      }

      entry.subscribers.add(subscriber);
    },
    cancel() {
      if (subscriber) {
        entry.subscribers.delete(subscriber);
      }
    }
  });
}
