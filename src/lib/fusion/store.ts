import { Redis } from "@upstash/redis";
import {
  FusionRunEventSchema,
  FusionRunSchema,
  FusionThreadSchema
} from "./schemas.ts";
import type { FusionRun, FusionRunEvent, FusionThread } from "./types";

type FusionGlobal = typeof globalThis & {
  __fusionRuns?: Map<string, FusionRun>;
  __fusionRunEvents?: Map<string, FusionRunEvent[]>;
  __fusionThreadRuns?: Map<string, string[]>;
  __fusionThreads?: Map<string, FusionThread>;
  __fusionRedis?: Redis;
};

const globalForFusion = globalThis as FusionGlobal;
const runListKey = "fusion:runs";
const runKeyPrefix = "fusion:run:";
const runEventsKeyPrefix = "fusion:run-events:";
const threadListKey = "fusion:threads";
const threadKeyPrefix = "fusion:thread:";
const threadRunsKeyPrefix = "fusion:thread-runs:";

function redisConfig() {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    return undefined;
  }

  return { url, token };
}

function redis() {
  const config = redisConfig();
  if (!config) {
    return undefined;
  }

  if (!globalForFusion.__fusionRedis) {
    globalForFusion.__fusionRedis = new Redis(config);
  }

  return globalForFusion.__fusionRedis;
}

function runs() {
  if (!globalForFusion.__fusionRuns) {
    globalForFusion.__fusionRuns = new Map();
  }
  return globalForFusion.__fusionRuns;
}

function runEvents() {
  if (!globalForFusion.__fusionRunEvents) {
    globalForFusion.__fusionRunEvents = new Map();
  }
  return globalForFusion.__fusionRunEvents;
}

function threadRuns() {
  if (!globalForFusion.__fusionThreadRuns) {
    globalForFusion.__fusionThreadRuns = new Map();
  }
  return globalForFusion.__fusionThreadRuns;
}

function threads() {
  if (!globalForFusion.__fusionThreads) {
    globalForFusion.__fusionThreads = new Map();
  }
  return globalForFusion.__fusionThreads;
}

/** Order runs by conversation turn, then by creation time. */
function byTurnThenCreated(left: FusionRun, right: FusionRun) {
  return (
    (left.metadata.turn_index ?? 0) - (right.metadata.turn_index ?? 0) ||
    new Date(left.created_at).getTime() - new Date(right.created_at).getTime()
  );
}

function orderedRuns(records: FusionRun[]) {
  return [...records].sort(byTurnThenCreated);
}

function threadTitle(prompt: string) {
  const title = prompt.trim().replace(/\s+/g, " ");
  return title.length > 80 ? `${title.slice(0, 77)}...` : title || "Untitled thread";
}

function threadFromRuns(
  threadId: string,
  records: FusionRun[],
  existing?: FusionThread
) {
  const ordered = orderedRuns(records);
  const first = ordered[0];
  const latest = ordered.at(-1);

  if (!first || !latest) {
    return undefined;
  }

  return FusionThreadSchema.parse({
    id: threadId,
    object: "fusion.thread",
    title:
      existing?.first_run_id === first.id
        ? existing.title
        : threadTitle(first.prompt),
    created_at: first.created_at,
    updated_at: latest.completed_at,
    archived: existing?.archived ?? false,
    run_count: ordered.length,
    first_run_id: first.id,
    latest_run_id: latest.id,
    latest_prompt: latest.prompt,
    latest_mode: latest.mode,
    latest_status: latest.status,
    total_cost_usd: Number(
      ordered.reduce((sum, run) => sum + run.cost_usd, 0).toFixed(6)
    ),
    total_latency_ms: ordered.reduce(
      (sum, run) => sum + run.latency_ms.end_to_end,
      0
    )
  });
}

async function upsertThreadForRun(record: FusionRun, durable?: Redis) {
  const threadId = record.metadata.thread_id;
  if (!threadId) {
    return undefined;
  }

  const threadRecords = await listThreadRuns(threadId);

  if (durable) {
    const existing = await durable.get<FusionThread>(`${threadKeyPrefix}${threadId}`);
    const thread = threadFromRuns(
      threadId,
      threadRecords,
      FusionThreadSchema.safeParse(existing).data
    );
    if (!thread) {
      return undefined;
    }
    await durable.set(`${threadKeyPrefix}${thread.id}`, thread);
    await durable.lrem(threadListKey, 0, thread.id);
    await durable.lpush(threadListKey, thread.id);
    await durable.ltrim(threadListKey, 0, 99);
    return thread;
  }

  const store = threads();
  const thread = threadFromRuns(threadId, threadRecords, store.get(threadId));
  if (!thread) {
    return undefined;
  }
  store.set(thread.id, thread);
  return thread;
}

export async function saveRun(run: FusionRun) {
  const record = FusionRunSchema.parse(run);
  const durable = redis();
  const threadId = record.metadata.thread_id;

  if (durable) {
    await durable.set(`${runKeyPrefix}${record.id}`, record);
    await durable.lrem(runListKey, 0, record.id);
    await durable.lpush(runListKey, record.id);
    await durable.ltrim(runListKey, 0, 99);
    if (threadId) {
      const key = `${threadRunsKeyPrefix}${threadId}`;
      await durable.lrem(key, 0, record.id);
      await durable.lpush(key, record.id);
      await durable.ltrim(key, 0, 199);
    }
    await upsertThreadForRun(record, durable);
    return record;
  }

  const store = runs();
  store.set(record.id, record);
  if (threadId) {
    const index = threadRuns();
    const ids = index.get(threadId)?.filter((id) => id !== record.id) ?? [];
    ids.unshift(record.id);
    index.set(threadId, ids.slice(0, 200));
  }
  await upsertThreadForRun(record);

  if (store.size > 100) {
    const oldest = store.keys().next().value;
    if (oldest) {
      store.delete(oldest);
    }
  }

  return record;
}

export async function listThreads() {
  const durable = redis();

  if (durable) {
    const ids = await durable.lrange<string>(threadListKey, 0, 99);
    const records = await Promise.all(
      ids.map((id) => durable.get<FusionThread>(`${threadKeyPrefix}${id}`))
    );
    return records
      .map((thread) => FusionThreadSchema.safeParse(thread))
      .filter((result) => result.success)
      .map((result) => result.data);
  }

  return [...threads().values()].sort(
    (left, right) =>
      new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime()
  );
}

export async function getThread(id: string) {
  const durable = redis();

  if (durable) {
    const thread = await durable.get<FusionThread>(`${threadKeyPrefix}${id}`);
    return FusionThreadSchema.safeParse(thread).data;
  }

  return FusionThreadSchema.safeParse(threads().get(id)).data;
}

export async function listThreadRuns(threadId: string) {
  const durable = redis();

  if (durable) {
    const ids = await durable.lrange<string>(`${threadRunsKeyPrefix}${threadId}`, 0, 199);
    const records = await Promise.all(
      ids.map((id) => durable.get<FusionRun>(`${runKeyPrefix}${id}`))
    );
    return records
      .map((run) => FusionRunSchema.safeParse(run))
      .filter((result) => result.success)
      .map((result) => result.data)
      .sort(byTurnThenCreated);
  }

  const ids = threadRuns().get(threadId) ?? [];
  return ids
    .map((id) => FusionRunSchema.safeParse(runs().get(id)))
    .filter((result) => result.success)
    .map((result) => result.data)
    .sort(byTurnThenCreated);
}

export async function listRuns() {
  const durable = redis();

  if (durable) {
    const ids = await durable.lrange<string>(runListKey, 0, 99);
    const records = await Promise.all(
      ids.map((id) => durable.get<FusionRun>(`${runKeyPrefix}${id}`))
    );
    return records
      .map((run) => FusionRunSchema.safeParse(run))
      .filter((result) => result.success)
      .map((result) => result.data);
  }

  return [...runs().values()].sort(
    (left, right) =>
      new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
  );
}

export async function getRun(id: string) {
  const durable = redis();

  if (durable) {
    const run = await durable.get<FusionRun>(`${runKeyPrefix}${id}`);
    return FusionRunSchema.safeParse(run).data;
  }

  return FusionRunSchema.safeParse(runs().get(id)).data;
}

export async function saveRunEvents(runId: string, events: FusionRunEvent[]) {
  const sorted = events
    .map((event) => FusionRunEventSchema.parse(event))
    .sort((left, right) => left.sequence - right.sequence);
  const durable = redis();

  if (durable) {
    await durable.set(`${runEventsKeyPrefix}${runId}`, sorted);
    return sorted;
  }

  runEvents().set(runId, sorted);
  return sorted;
}

export async function getRunEvents(runId: string) {
  const durable = redis();

  if (durable) {
    const events = (await durable.get<FusionRunEvent[]>(`${runEventsKeyPrefix}${runId}`)) ?? [];
    return events
      .map((event) => FusionRunEventSchema.safeParse(event))
      .filter((result) => result.success)
      .map((result) => result.data);
  }

  return (runEvents().get(runId) ?? [])
    .map((event) => FusionRunEventSchema.safeParse(event))
    .filter((result) => result.success)
    .map((result) => result.data);
}

export function storeMode() {
  return redisConfig() ? "redis" : "memory";
}
