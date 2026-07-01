import { requireApiAuth } from "./auth.ts";
import { jsonError } from "./http-errors.ts";
import {
  getThread,
  listThreadRuns,
  listThreads
} from "./store.ts";
import type { FusionRun, FusionThread } from "./types.ts";

export type ThreadHandlerDeps = {
  listThreadRecords?: () => Promise<FusionThread[]>;
  getThreadRecord?: (id: string) => Promise<FusionThread | undefined>;
  listThreadRunRecords?: (threadId: string) => Promise<FusionRun[]>;
};

function notFound(id: string) {
  return jsonError("not_found", `No thread exists with id ${id}.`, 404);
}

export async function handleThreadsList(
  request: Request,
  deps: ThreadHandlerDeps = {}
) {
  const authError = requireApiAuth(request);
  if (authError) {
    return authError;
  }

  return Response.json({
    object: "list",
    data: await (deps.listThreadRecords ?? listThreads)()
  });
}

export async function handleThreadGet(
  request: Request,
  id: string,
  deps: ThreadHandlerDeps = {}
) {
  const authError = requireApiAuth(request);
  if (authError) {
    return authError;
  }

  const thread = await (deps.getThreadRecord ?? getThread)(id);
  if (!thread) {
    return notFound(id);
  }

  return Response.json({
    object: "fusion.thread.detail",
    thread,
    runs: await (deps.listThreadRunRecords ?? listThreadRuns)(id)
  });
}
