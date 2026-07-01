import type { EffortLevel, WebFetchConfig, WebSearchConfig } from "./schemas";

export type {
  EffortLevel,
  FailedModel,
  FailureReason,
  CostCoverage,
  FusionResult,
  FusionRun,
  FusionRunEvent,
  FusionRunEventType,
  FusionRunMetadata,
  FusionStatus,
  FusionThread,
  FusionThreadDetail,
  FusionThreadsResponse,
  PanelResponse,
  ProviderCallMetadata,
  SourceRecord,
  UsageRecord,
  WebFetchConfig,
  WebSearchConfig
} from "./schemas";

/**
 * One tool invocation a node's model made, reported as soon as the step that
 * issued it settles. The orchestrator turns this into a `node.tool.*` run event
 * so the studio can render live tool activity per model. `result` is the raw
 * tool output (e.g. search results) for an expandable preview; `is_error` marks
 * a tool that came back with an error payload.
 */
export type NodeToolReport = {
  tool: string;
  call_id: string;
  args?: unknown;
  result?: unknown;
  is_error: boolean;
};

export type ModelCallOptions = {
  model: string;
  role: string;
  prompt: string;
  system: string;
  webEnabled: boolean;
  webSearch?: WebSearchConfig;
  webFetch?: WebFetchConfig;
  localToolsEnabled: boolean;
  maxToolCalls: number;
  temperature?: number;
  maxOutputTokens?: number;
  effort?: EffortLevel;
  /** Called as each tool invocation settles, for live per-node activity. */
  onTool?: (report: NodeToolReport) => void;
  /** Called per text delta so the studio can show this node typing live. */
  onDelta?: (text: string) => void;
  /** Aborts the upstream call when the client stops or disconnects. */
  signal?: AbortSignal;
};
