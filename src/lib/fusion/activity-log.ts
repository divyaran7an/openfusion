import type { GraphRole } from "./graph.ts";
import type { FusionRunEvent } from "./types.ts";

/**
 * The live activity model behind the studio's run drawer. The orchestrator
 * streams `fusion_event`s as the council works; we fold them into one row per
 * model — its status, timing, tokens, and the tools it called — which the
 * drawer renders (modeled on how t3code renders an agent's step list).
 *
 * Kept pure and free of React so it's trivial to unit-test against a recorded
 * event sequence: feed events through `reduceActivity` and assert the rows.
 */

export type ActivityToolStatus = "done" | "failed";

export type ActivityTool = {
  callId: string;
  tool: string;
  args?: unknown;
  result?: unknown;
  status: ActivityToolStatus;
};

export type ActivityNodeStatus = "idle" | "running" | "done" | "failed";

export type ActivityNode = {
  key: string;
  role: GraphRole;
  index?: number;
  model: string;
  label: string;
  status: ActivityNodeStatus;
  startedAt?: number;
  finishedAt?: number;
  /** A panel's own answer, shown so each model is readable before synthesis. */
  text?: string;
  tokens?: number;
  /** Why this node failed (the provider/harness error), shown on a failed row. */
  error?: string;
  tools: ActivityTool[];
};

// Stable key per council seat: panels are addressed by index, the judge and
// synthesizer are singletons. Lifecycle events (`panel.started` …) and per-tool
// events (`node.tool.*`) both resolve to the same key.
export function activityKey(role: string, index?: number): string {
  if (role === "panel") return `panel:${index ?? 0}`;
  return role;
}

function eventTime(event: FusionRunEvent): number {
  const parsed = Date.parse(event.created_at);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function totalTokens(usage: unknown): number | undefined {
  const u = usage as
    | { total_tokens?: number; input_tokens?: number; output_tokens?: number }
    | undefined;
  if (!u) return undefined;
  if (typeof u.total_tokens === "number") return u.total_tokens;
  const sum = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
  return sum > 0 ? sum : undefined;
}

function roleFor(event: FusionRunEvent, data: Record<string, unknown>): GraphRole | undefined {
  // The structural role comes from the event TYPE — lifecycle events carry a
  // display label in data.role ("panelist 1"), not the role, so trusting it
  // would drop panels into the wrong group (or none).
  if (event.type.startsWith("panel")) return "panel";
  if (event.type.startsWith("judge")) return "judge";
  if (event.type.startsWith("synthesis")) return "synthesizer";
  // node.* events (delta/tool) carry the real structural role in data.role.
  if (data.role === "panel" || data.role === "judge" || data.role === "synthesizer") {
    return data.role;
  }
  return undefined;
}

function labelFor(role: GraphRole, index?: number): string {
  if (role === "panel") return `Panel ${(index ?? 0) + 1}`;
  return role === "judge" ? "Judge" : "Synthesizer";
}

/**
 * Fold one run event into the activity list, returning a new list. Rows stay in
 * the order their nodes first appear; events for an unknown role pass through
 * untouched (e.g. `run.started`, `run.completed`).
 */
export function reduceActivity(
  nodes: ActivityNode[],
  event: FusionRunEvent
): ActivityNode[] {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const role = roleFor(event, data);
  if (!role) return nodes;
  const index = typeof data.index === "number" ? data.index : undefined;
  const key = activityKey(role, index);

  const next = nodes.slice();
  let i = next.findIndex((node) => node.key === key);
  if (i === -1) {
    next.push({
      key,
      role,
      index,
      model: typeof data.model === "string" ? data.model : "",
      label: labelFor(role, index),
      status: "idle",
      tools: []
    });
    i = next.length - 1;
  }

  const node: ActivityNode = { ...next[i], tools: next[i].tools.slice() };
  if (typeof data.model === "string" && data.model) node.model = data.model;

  switch (event.type) {
    case "panel.started":
    case "judge.started":
    case "synthesis.started":
      node.status = "running";
      node.startedAt = eventTime(event);
      break;
    case "panel.finished":
    case "judge.finished":
    case "synthesis.finished":
      node.status = "done";
      node.finishedAt = eventTime(event);
      if (typeof data.text === "string") node.text = data.text;
      node.tokens = totalTokens(data.usage) ?? node.tokens;
      break;
    case "panel.failed":
    case "judge.failed":
    case "synthesis.failed":
      node.status = "failed";
      node.finishedAt = eventTime(event);
      // Keep the real reason — the provider/harness error or classified reason —
      // so the drawer can tell you exactly why this model dropped out.
      if (typeof data.error === "string" && data.error.trim()) node.error = data.error.trim();
      else if (typeof data.failure_reason === "string") node.error = data.failure_reason;
      break;
    case "node.delta":
      // Accumulate the node's streamed output. A later `*.finished` may replace
      // this with the trimmed full text; identical content, so no flicker.
      if (typeof data.text === "string") node.text = (node.text ?? "") + data.text;
      break;
    case "node.tool.finished":
    case "node.tool.failed": {
      const callId =
        typeof data.call_id === "string" && data.call_id
          ? data.call_id
          : `${key}:${node.tools.length}`;
      const tool: ActivityTool = {
        callId,
        tool: typeof data.tool === "string" ? data.tool : "tool",
        args: data.args,
        result: data.result,
        status: event.type === "node.tool.failed" ? "failed" : "done"
      };
      const existing = node.tools.findIndex((entry) => entry.callId === callId);
      if (existing === -1) node.tools.push(tool);
      else node.tools[existing] = tool;
      break;
    }
  }

  next[i] = node;
  return next;
}
