import { FUSION_PRESETS, modeFromModel, type FusionPreset } from "./models.ts";
import { providerCostReport } from "./costing.ts";
import {
  fusionOuterSystemPrompt,
  judgePrompt,
  panelSystemPrompt,
  promptFromMessages,
  promptWithContext,
  synthPrompt
} from "./prompts.ts";
import type {
  ChatMessage,
  EffortLevel,
  FusionMode,
  NodeConfig,
  ProviderCallMetadata,
  RunRequest,
  WebFetchConfig,
  WebSearchConfig
} from "./schemas.ts";
import { runtimeLabel } from "./model-routing.ts";
import {
  assertBackendsAvailable,
  callJudge,
  callOuterModelWithFusionTool,
  callPanelModel,
  callSynthesis,
  FusionConfigurationError,
  hasLocalTools,
  hasParallelExtractCredentials,
  hasWebFetchFor,
  hasWebToolsFor
} from "./provider.ts";
import type {
  FusionResult,
  FusionRun,
  FusionRunEvent,
  FusionRunMetadata,
  FailureReason,
  PanelResponse,
  UsageRecord
} from "./types.ts";
import { classifyJudgeError, classifyProviderError } from "./errors.ts";
import { shortId as createId } from "./ids.ts";
import {
  applyStopSequences,
  assertResponseFormatSatisfied,
  assertResponseFormatSupported,
  assertTextOnlyMessages,
  requiresBufferedResponse,
  stopSequencesFrom
} from "./openai-compat.ts";
import { outputBudgetsForRequest } from "./output-budgets.ts";
import { assertRunWithinBudget, recordRunSpend } from "./budget.ts";

/**
 * Every completed run — success or error, from any entry path — lands in the
 * spend ledger here, before the handler saves it. Error runs still spent panel
 * money, and a post-run assertion in a handler must not lose the ledger line.
 */
function ledgeredRun(run: FusionRun): FusionRun {
  recordRunSpend(run);
  return run;
}

function panelLabel(index: number) {
  return `panelist ${index + 1}`;
}

/**
 * Resolve a node's web access. When no per-node config is supplied (the
 * non-graph / legacy path) the preset's global toggle leads, preserving existing
 * behavior byte-for-byte. With a config, the node's own `web` flag decides —
 * still bounded by the preset's hard gate.
 */
function nodeWebEnabled(presetWebEnabled: boolean, config: NodeConfig | undefined) {
  if (!config) {
    return presetWebEnabled;
  }
  return presetWebEnabled && config.web === true;
}

/** A node's own effort if set, otherwise the run-level fallback. */
function nodeEffort(config: NodeConfig | undefined, fallback: EffortLevel | undefined) {
  return config?.effort ?? fallback;
}

type WebRuntimeNode = {
  model?: string;
  config?: NodeConfig;
};

function nodeWebAvailable(
  presetWebEnabled: boolean,
  node: WebRuntimeNode,
  check: (model: string, webEnabled: boolean) => boolean
) {
  return Boolean(
    node.model &&
      check(node.model, nodeWebEnabled(presetWebEnabled, node.config))
  );
}

function anyNodeWebAvailable(
  presetWebEnabled: boolean,
  nodes: WebRuntimeNode[],
  check: (model: string, webEnabled: boolean) => boolean
) {
  return nodes.some((node) => nodeWebAvailable(presetWebEnabled, node, check));
}

function emptyUsage(): UsageRecord {
  return {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0
  };
}

function addUsage(left: UsageRecord, right: UsageRecord): UsageRecord {
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    total_tokens: left.total_tokens + right.total_tokens
  };
}

// Fallback blended price per 1M tokens (USD) used only when Vercel AI Gateway doesn't
// report real generation cost. Each panel model adds ~0.7; the synthesis pass
// adds a base 2 (panel+judge+synth) and analysis-only adds a base 1 (panel+judge).
const TOKENS_PER_MILLION = 1_000_000;
const PER_PANEL_USD_PER_MTOK = 0.7;
const SYNTH_BASE_USD_PER_MTOK = 2;
const ANALYSIS_BASE_USD_PER_MTOK = 1;

function estimateCost(usage: UsageRecord, panelSize: number) {
  const pricePerMtok = SYNTH_BASE_USD_PER_MTOK + panelSize * PER_PANEL_USD_PER_MTOK;
  return Number(((usage.total_tokens / TOKENS_PER_MILLION) * pricePerMtok).toFixed(6));
}

function estimateAnalysisCost(usage: UsageRecord, panelSize: number) {
  const pricePerMtok = ANALYSIS_BASE_USD_PER_MTOK + panelSize * PER_PANEL_USD_PER_MTOK;
  return Number(((usage.total_tokens / TOKENS_PER_MILLION) * pricePerMtok).toFixed(6));
}

function dedupeSources(sources: FusionRun["sources"]) {
  const seen = new Set<string>();

  return sources.filter((source) => {
    const key = source.url ?? `${source.provider ?? ""}:${source.title ?? ""}:${source.snippet ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function providerGenerations(entries: Array<ProviderCallMetadata | undefined>) {
  const seen = new Set<string>();

  return entries
    .filter((entry): entry is ProviderCallMetadata => Boolean(entry))
    .filter((entry) => {
      const key =
        entry.generation_id ??
        entry.request_id ??
        entry.response_id ??
        `${entry.provider ?? ""}:${entry.model ?? ""}:${entry.timestamp ?? ""}`;

      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function allPanelFailureReason(failedModels: FusionRun["failed_models"]): FailureReason {
  const reasons = failedModels
    .map((model) => model.failure_reason)
    .filter((reason): reason is FailureReason => Boolean(reason));

  if (reasons.includes("insufficient_credits")) {
    return "insufficient_credits";
  }

  if (reasons.includes("rate_limited")) {
    return "rate_limited";
  }

  if (reasons.length > 0 && reasons.every((reason) => reason === "provider_timeout")) {
    return "provider_timeout";
  }

  if (reasons.length > 0 && reasons.every((reason) => reason === "policy_blocked")) {
    return "policy_blocked";
  }

  return "all_panels_failed";
}

function failedRunMessage(reason: FailureReason) {
  switch (reason) {
    case "insufficient_credits":
      return "Fusion could not produce a useful result because every panel model failed due to provider credit or quota limits.";
    case "rate_limited":
      return "Fusion could not produce a useful result because every panel model was rate limited.";
    case "provider_timeout":
      return "Fusion could not produce a useful result because every panel model timed out.";
    case "policy_blocked":
      return "Fusion could not produce a useful result because every panel model was blocked by provider policy.";
    default:
      return "Fusion could not produce a useful result because every panel model failed.";
  }
}

function cappedFusionResult(input: {
  prompt: string;
  preset: FusionPreset;
  panelModels: string[];
  judgeModel?: string;
  outerModel: string;
  traceId: string;
  strictFusion: boolean;
  thread: ThreadContext;
  latencyMs: number;
}): FusionResult {
  return {
    object: "fusion.result",
    status: "error",
    degraded: false,
    failure_reason: "fusion_invocation_capped",
    prompt: input.prompt,
    responses: [],
    failed_models: [],
    sources: [],
    usage: emptyUsage(),
    latency_ms: {
      panel_max: 0,
      judge: 0,
      end_to_end: input.latencyMs
    },
    cost_usd: 0,
    metadata: runtimeMetadata({
      traceId: input.traceId,
      preset: input.preset,
      panelModels: input.panelModels,
      judgeModel: input.judgeModel,
      outerModel: input.outerModel,
      strictFusion: input.strictFusion,
      thread: input.thread
    })
  };
}

function modeForRequest(request: RunRequest): FusionMode {
  return request.model ? modeFromModel(request.model) : request.mode;
}

function safeModeForRequest(request: RunRequest): FusionMode {
  try {
    return modeForRequest(request);
  } catch {
    return request.mode ?? "openfusion";
  }
}

export function outerModelForAgenticRequest(request: RunRequest, preset: typeof FUSION_PRESETS[FusionMode]) {
  // Required synthesizer model: explicit override wins; the preset is the
  // documented default only for the legacy (non-graph) agentic path.
  return request.fusion?.outer_model ?? preset.outerModel;
}

export type RunFusionOptions = {
  onEvent?: (event: FusionRunEvent) => void | Promise<void>;
  /** Sink for the synthesizer's text deltas, used to stream the answer live. */
  onToken?: (delta: string) => void;
  /** Cancels every upstream model call when the client stops or disconnects. */
  signal?: AbortSignal;
};

type EmitRuntimeEvent = (
  type: FusionRunEvent["type"],
  data: FusionRunEvent["data"]
) => Promise<void>;

// Coalesce a node's output tokens into ~paragraph-sized `node.delta` events.
// Token-granular events would flood the stream and thrash the studio; flushing
// on a character threshold keeps the drawer's live typing smooth and cheap.
// `flush()` drains the tail once the node's call resolves.
function nodeDeltaBuffer(emit: EmitRuntimeEvent, base: Record<string, unknown>) {
  const FLUSH_CHARS = 64;
  let buffer = "";
  return {
    push: (text: string) => {
      if (!text) return;
      buffer += text;
      if (buffer.length >= FLUSH_CHARS) {
        const chunk = buffer;
        buffer = "";
        void emit("node.delta", { ...base, text: chunk });
      }
    },
    flush: async () => {
      if (!buffer) return;
      const chunk = buffer;
      buffer = "";
      await emit("node.delta", { ...base, text: chunk });
    }
  };
}

type ThreadContext = {
  threadId: string;
  parentRunId?: string;
  turnIndex: number;
};

function metadataString(metadata: RunRequest["metadata"], key: string) {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function metadataNumber(metadata: RunRequest["metadata"], key: string) {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function threadContextForRequest(request: RunRequest): ThreadContext {
  const parentRunId =
    request.parent_run_id ?? metadataString(request.metadata, "parent_run_id");
  const threadId =
    request.thread_id ??
    metadataString(request.metadata, "thread_id") ??
    parentRunId ??
    createId("thr");
  const turnIndex =
    request.turn_index ??
    metadataNumber(request.metadata, "turn_index") ??
    (parentRunId ? 1 : 0);

  return { threadId, parentRunId, turnIndex };
}

function runtimeMetadata(input: {
  traceId: string;
  preset: FusionPreset;
  panelModels: string[];
  judgeModel?: string;
  outerModel: string;
  panelConfig?: NodeConfig[];
  judgeConfig?: NodeConfig;
  synthConfig?: NodeConfig;
  strictFusion: boolean;
  thread: ThreadContext;
}): FusionRunMetadata {
  const localToolsEnabled = input.strictFusion ? false : input.preset.localToolsEnabled;
  const webNodes = [
    ...input.panelModels.map((model, index) => ({
      model,
      config: input.panelConfig?.[index]
    })),
    { model: input.judgeModel, config: input.judgeConfig },
    { model: input.outerModel, config: input.synthConfig }
  ];
  const anyWebEnabled = webNodes.some((node) =>
    Boolean(node.model && nodeWebEnabled(input.preset.webEnabled, node.config))
  );

  return {
    trace_id: input.traceId,
    panel_size: input.panelModels.length,
    panel_models: input.panelModels,
    ...(input.judgeModel ? { judge_model: input.judgeModel } : {}),
    outer_model: input.outerModel,
    runtime: runtimeLabel([
      ...input.panelModels,
      ...(input.judgeModel ? [input.judgeModel] : []),
      input.outerModel
    ]),
    fusion_mode: input.strictFusion ? "strict_openrouter" : "fusion",
    web_enabled: anyWebEnabled,
    web_tools_available: anyNodeWebAvailable(
      input.preset.webEnabled,
      webNodes,
      hasWebToolsFor
    ),
    web_fetch_available: anyNodeWebAvailable(
      input.preset.webEnabled,
      webNodes,
      hasWebFetchFor
    ),
    local_tools_enabled: localToolsEnabled,
    local_tools_available: localToolsEnabled && hasLocalTools(),
    judge_web_tools_available: input.judgeModel
      ? hasWebToolsFor(
          input.judgeModel,
          nodeWebEnabled(input.preset.webEnabled, input.judgeConfig)
        )
      : false,
    outer_web_tools_available: hasWebToolsFor(
      input.outerModel,
      nodeWebEnabled(input.preset.webEnabled, input.synthConfig)
    ),
    web_extract_available: input.preset.webEnabled && hasParallelExtractCredentials(),
    thread_id: input.thread.threadId,
    parent_run_id: input.thread.parentRunId,
    turn_index: input.thread.turnIndex
  };
}

async function runFusionAnalysis(input: {
  prompt: string;
  preset: FusionPreset;
  panelModels: string[];
  judgeModel?: string;
  outerModel: string;
  maxToolCalls: number;
  temperature?: number;
  effort?: EffortLevel;
  panelConfig?: NodeConfig[];
  judgeConfig?: NodeConfig;
  synthConfig?: NodeConfig;
  webSearch?: WebSearchConfig;
  webFetch?: WebFetchConfig;
  innerMaxOutputTokens?: number;
  traceId: string;
  strictFusion: boolean;
  thread: ThreadContext;
  emit: EmitRuntimeEvent;
  signal?: AbortSignal;
}): Promise<FusionResult> {
  const started = Date.now();
  const localToolsEnabled = input.strictFusion ? false : input.preset.localToolsEnabled;
  const metadata = runtimeMetadata({
    traceId: input.traceId,
    preset: input.preset,
    panelModels: input.panelModels,
    judgeModel: input.judgeModel,
    outerModel: input.outerModel,
    panelConfig: input.panelConfig,
    judgeConfig: input.judgeConfig,
    synthConfig: input.synthConfig,
    strictFusion: input.strictFusion,
    thread: input.thread
  });

  const panel = await Promise.allSettled(
    input.panelModels.map(async (model, index) => {
      const role = panelLabel(index);
      const panelStarted = Date.now();
      await input.emit("panel.started", { model, role, index });

      const deltas = nodeDeltaBuffer(input.emit, { role: "panel", index, model });
      try {
        const panelConfig = input.panelConfig?.[index];
        const response = await callPanelModel({
          model,
          role,
          prompt: input.prompt,
          system: panelSystemPrompt({ localToolsEnabled }),
          webEnabled: nodeWebEnabled(input.preset.webEnabled, panelConfig),
          webSearch: input.webSearch,
          webFetch: input.webFetch,
          localToolsEnabled,
          maxToolCalls: input.maxToolCalls,
          temperature: input.temperature,
          maxOutputTokens: input.innerMaxOutputTokens,
          effort: nodeEffort(panelConfig, input.effort),
          signal: input.signal,
          onDelta: deltas.push,
          onTool: (report) =>
            void input.emit(
              report.is_error ? "node.tool.failed" : "node.tool.finished",
              { role: "panel", index, model, ...report }
            )
        });
        await deltas.flush();
        await input.emit("panel.finished", {
          model,
          role,
          index,
          // The panel's own answer, so the studio's activity log can show what
          // each model said before the judge and synthesizer fold it in.
          text: response.content,
          latency_ms: response.latency_ms,
          usage: response.usage,
          source_count: response.sources.length,
          generation_id: response.provider_metadata?.generation_id
        });
        return response;
      } catch (error) {
        await input.emit("panel.failed", {
          model,
          role,
          index,
          latency_ms: Date.now() - panelStarted,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    })
  );

  const responses: PanelResponse[] = [];
  const failedModels: FusionRun["failed_models"] = [];

  panel.forEach((result, index) => {
    if (result.status === "fulfilled") {
      responses.push(result.value);
    } else {
      const failureReason = classifyProviderError(result.reason);
      failedModels.push({
        model: input.panelModels[index],
        error:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
        failure_reason: failureReason
      });
    }
  });

  if (responses.length === 0) {
    const endToEnd = Date.now() - started;
    const failureReason = allPanelFailureReason(failedModels);
    return {
      object: "fusion.result",
      status: "error",
      degraded: false,
      failure_reason: failureReason,
      prompt: input.prompt,
      responses,
      failed_models: failedModels,
      sources: [],
      usage: emptyUsage(),
      latency_ms: {
        panel_max: endToEnd,
        judge: 0,
        end_to_end: endToEnd
      },
      cost_usd: 0,
      metadata
    };
  }

  let analysis: FusionRun["analysis"];
  let judgeLatency = 0;
  let judgeUsage = emptyUsage();
  let judgeSources: FusionRun["sources"] = [];
  let judgeProviderMetadata: ProviderCallMetadata | undefined;
  let judgeSucceeded = false;
  let degraded = failedModels.length > 0;
  let degradedFailureReason: FailureReason | undefined;

  if (responses.length > 1 && input.judgeModel) {
    const judgeModel = input.judgeModel;
    try {
      await input.emit("judge.started", {
        model: judgeModel,
        response_count: responses.length
      });
      const judge = await callJudge(
        judgeModel,
        judgePrompt(input.prompt, responses, { localToolsEnabled }),
        {
          webEnabled: nodeWebEnabled(input.preset.webEnabled, input.judgeConfig),
          webSearch: input.webSearch,
          webFetch: input.webFetch,
          localToolsEnabled,
          maxToolCalls: input.maxToolCalls,
          temperature: input.temperature,
          maxOutputTokens: input.innerMaxOutputTokens,
          effort: nodeEffort(input.judgeConfig, input.effort),
          signal: input.signal,
          onTool: (report) =>
            void input.emit(
              report.is_error ? "node.tool.failed" : "node.tool.finished",
              { role: "judge", model: judgeModel, ...report }
            )
        }
      );
      analysis = judge.analysis;
      judgeLatency = judge.latency_ms;
      judgeUsage = judge.usage;
      judgeSources = judge.sources;
      judgeProviderMetadata = judge.provider_metadata;
      judgeSucceeded = true;
      await input.emit("judge.finished", {
        model: judgeModel,
        latency_ms: judge.latency_ms,
        usage: judge.usage,
        source_count: judge.sources.length,
        generation_id: judge.provider_metadata?.generation_id
      });
    } catch (error) {
      degraded = true;
      degradedFailureReason = classifyJudgeError(error);
      await input.emit("judge.failed", {
        model: judgeModel,
        failure_reason: degradedFailureReason,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const usage = responses
    .map((response) => response.usage)
    .reduce(addUsage, judgeUsage);
  const sources = dedupeSources([
    ...responses.flatMap((response) => response.sources),
    ...judgeSources
  ]);
  const endToEnd = Date.now() - started;
  const panelMax = Math.max(...responses.map((response) => response.latency_ms), 0);
  const generationMetadata = providerGenerations([
    ...responses.map((response) => response.provider_metadata),
    judgeProviderMetadata
  ]);
  const costReport = providerCostReport(
    generationMetadata,
    responses.length + (judgeSucceeded ? 1 : 0)
  );
  const costUsd =
    costReport.cost_usd ?? estimateAnalysisCost(usage, input.panelModels.length);

  return {
    object: "fusion.result",
    status: "ok",
    degraded,
    failure_reason: degradedFailureReason,
    prompt: input.prompt,
    analysis,
    responses,
    failed_models: failedModels,
    sources,
    usage,
    latency_ms: {
      panel_max: panelMax,
      judge: judgeLatency,
      end_to_end: endToEnd
    },
    cost_usd: costUsd,
    metadata: {
      ...metadata,
      cost_source: costReport.cost_source,
      cost_coverage: costReport.cost_coverage,
      provider_generations: generationMetadata
    }
  };
}

export async function runFusion(
  request: RunRequest,
  options: RunFusionOptions = {}
): Promise<FusionRun> {
  assertResponseFormatSupported(request.response_format);
  assertTextOnlyMessages(request.messages);
  assertTextOnlyMessages(request.context_messages);

  const started = Date.now();
  const createdAt = new Date(started).toISOString();
  const runId = createId("run");
  const traceId = createId("trc");
  let eventSequence = 0;
  // Any model id is accepted: the active graph drives the real config, and the
  // mode is only a metadata label. Unknown ids resolve to the default rather
  // than 400ing, so clients that send their own model name (aider's gpt-4o,
  // Cursor/Continue defaults) work as a true OpenAI drop-in.
  const mode = safeModeForRequest(request);
  const preset = FUSION_PRESETS[mode];
  const userPrompt = promptFromMessages(
    request.messages as ChatMessage[] | undefined,
    request.prompt
  );
  const prompt = promptWithContext(
    request.context_messages as ChatMessage[] | undefined,
    userPrompt
  );
  const thread = threadContextForRequest(request);
  const panelModels = request.fusion?.panel_models ?? preset.panelModels;
  // When the request supplies its own panel (a graph/override-driven run) the
  // judge is exactly what was specified — never invented from a preset. The
  // judge is optional: no judge model means the synthesizer reads raw panels.
  const judgeModel = request.fusion?.panel_models
    ? request.fusion?.judge_model
    : request.fusion?.judge_model ?? preset.judgeModel;
  // The synthesizer is required. Graph-driven runs always carry outer_model
  // (graphToOverride sets it; mergeActiveGraph throws on an invalid graph), so
  // the preset default only applies to direct orchestrator callers that skip
  // the graph merge — a documented mode default, not an invented model.
  const outerModel = request.fusion?.outer_model ?? preset.outerModel;
  const effort = request.fusion?.effort;
  const panelConfig = request.fusion?.panel_config;
  const judgeConfig = request.fusion?.judge_config;
  const synthConfig = request.fusion?.synth_config;
  assertBackendsAvailable([
    ...panelModels,
    ...(panelModels.length > 1 && judgeModel ? [judgeModel] : []),
    outerModel
  ]);
  // Same judge rule as assertBackendsAvailable: a single-panel council never
  // runs its judge, so a configured hosted judge must not turn an otherwise
  // harness-only run into a budget-refusable one.
  assertRunWithinBudget([
    ...panelModels,
    ...(panelModels.length > 1 && judgeModel ? [judgeModel] : []),
    outerModel
  ]);
  const maxToolCalls = request.fusion?.max_tool_calls ?? preset.maxToolCalls;
  const temperature = request.fusion?.temperature ?? request.temperature;
  const stopSequences = stopSequencesFrom(request.stop);
  const outputBudgets = outputBudgetsForRequest(request);
  const strictFusion = request.fusion?.strict === true;
  const localToolsEnabled = strictFusion ? false : preset.localToolsEnabled;
  const webSearch = request.fusion?.web_search;
  const webFetch = request.fusion?.web_fetch;
  const bufferFinalResponse = requiresBufferedResponse(request.response_format);

  async function emit(type: FusionRunEvent["type"], data: FusionRunEvent["data"]) {
    const event: FusionRunEvent = {
      id: createId("evt"),
      object: "fusion.run.event",
      run_id: runId,
      sequence: eventSequence,
      type,
      created_at: new Date().toISOString(),
      data: {
        trace_id: traceId,
        ...data
      }
    };
    eventSequence += 1;
    await options.onEvent?.(event);
  }

  await emit("run.started", {
    mode,
    requested_model: request.model ?? preset.alias,
    panel_size: panelModels.length,
    panel_models: panelModels,
    judge_model: judgeModel,
    outer_model: outerModel,
    thread_id: thread.threadId,
    parent_run_id: thread.parentRunId,
    turn_index: thread.turnIndex,
    max_tool_calls: maxToolCalls,
    strict_fusion: strictFusion
  });

  const fusion = await runFusionAnalysis({
    prompt,
    preset,
    panelModels,
    judgeModel,
    outerModel,
    maxToolCalls,
    temperature,
    effort,
    panelConfig,
    judgeConfig,
    synthConfig,
    webSearch,
    webFetch,
    innerMaxOutputTokens: outputBudgets.inner,
    traceId,
    strictFusion,
    thread,
    emit,
    signal: options.signal
  });

  if (fusion.status === "error") {
    const completedAt = new Date().toISOString();
    const failureReason = fusion.failure_reason ?? "all_panels_failed";
    await emit("run.completed", {
      status: "error",
      degraded: false,
      failure_reason: failureReason,
      failed_model_count: fusion.failed_models.length,
      latency_ms: Date.now() - started
    });
    return ledgeredRun({
      id: runId,
      object: "fusion.run",
      created_at: createdAt,
      completed_at: completedAt,
      mode,
      requested_model: request.model ?? preset.alias,
      status: "error",
      degraded: false,
      failure_reason: failureReason,
      prompt: userPrompt,
      final: failedRunMessage(failureReason),
      responses: fusion.responses,
      failed_models: fusion.failed_models,
      sources: fusion.sources,
      usage: fusion.usage,
      latency_ms: {
        panel_max: fusion.latency_ms.panel_max,
        judge: fusion.latency_ms.judge,
        synthesis: 0,
        end_to_end: Date.now() - started
      },
      cost_usd: fusion.cost_usd,
      metadata: fusion.metadata
    });
  }

  await emit("synthesis.started", {
    model: outerModel,
    response_count: fusion.responses.length,
    judge_available: Boolean(fusion.analysis)
  });

  let synthesis: Awaited<ReturnType<typeof callSynthesis>>;
  const synthDeltas = nodeDeltaBuffer(emit, { role: "synthesizer", model: outerModel });
  try {
    synthesis = await callSynthesis(
      outerModel,
      synthPrompt(prompt, fusion.responses, fusion.analysis, {
        localToolsEnabled,
        responseFormat: request.response_format
      }),
      {
        webEnabled: nodeWebEnabled(preset.webEnabled, synthConfig),
        webSearch,
        webFetch,
        localToolsEnabled,
        maxToolCalls,
        temperature,
        topP: request.top_p,
        presencePenalty: request.presence_penalty,
        frequencyPenalty: request.frequency_penalty,
        seed: request.seed,
        stopSequences,
        maxOutputTokens: outputBudgets.final,
        effort: nodeEffort(synthConfig, effort),
        signal: options.signal,
        // The synthesizer's tokens go to the OpenAI answer stream and, coalesced,
        // to its row in the activity drawer — the same text, two surfaces.
        onToken: bufferFinalResponse
          ? undefined
          : (delta) => {
              options.onToken?.(delta);
              synthDeltas.push(delta);
            },
        onTool: (report) =>
          void emit(
            report.is_error ? "node.tool.failed" : "node.tool.finished",
            { role: "synthesizer", model: outerModel, ...report }
          )
      }
    );
    await synthDeltas.flush();
    await emit("synthesis.finished", {
      model: outerModel,
      latency_ms: synthesis.latency_ms,
      usage: synthesis.usage,
      source_count: synthesis.sources.length,
      generation_id: synthesis.provider_metadata?.generation_id
    });
  } catch (error) {
    await emit("synthesis.failed", {
      model: outerModel,
      error: error instanceof Error ? error.message : String(error)
    });
    // The panel (and judge) already spent hosted money even though no run
    // object will be produced — ledger the partial spend before failing.
    recordRunSpend({ id: runId, cost_usd: fusion.cost_usd, metadata: fusion.metadata });
    throw error;
  }

  const usage = addUsage(fusion.usage, synthesis.usage);
  const final = applyStopSequences(synthesis.text, request.stop);
  const generationMetadata = providerGenerations([
    ...(fusion.metadata.provider_generations ?? []),
    synthesis.provider_metadata
  ]);
  const costReport = providerCostReport(
    generationMetadata,
    fusion.responses.length +
      (fusion.analysis ? 1 : 0) +
      1
  );
  const costUsd = costReport.cost_usd ?? estimateCost(usage, panelModels.length);

  try {
    assertResponseFormatSatisfied(final, request.response_format);
  } catch (error) {
    // The whole council spent (panel, judge, and a successful synthesis) even
    // though the final text misses the response-format contract — ledger the
    // full spend before failing the run.
    recordRunSpend({
      id: runId,
      cost_usd: costUsd,
      metadata: {
        ...fusion.metadata,
        cost_source: costReport.cost_source,
        cost_coverage: costReport.cost_coverage,
        provider_generations: generationMetadata
      }
    });
    throw error;
  }

  const sources = dedupeSources([
    ...fusion.sources,
    ...synthesis.sources
  ]);
  const completedAt = new Date().toISOString();
  const endToEnd = Date.now() - started;
  const status = "ok";

  await emit("run.completed", {
    status,
    degraded: fusion.degraded,
    failed_model_count: fusion.failed_models.length,
    source_count: sources.length,
    cost_usd: costUsd,
    latency_ms: endToEnd
  });

  return ledgeredRun({
    id: runId,
    object: "fusion.run",
    created_at: createdAt,
    completed_at: completedAt,
    mode,
    requested_model: request.model ?? preset.alias,
    status,
    degraded: fusion.degraded,
    prompt: userPrompt,
    final,
    analysis: fusion.analysis,
    responses: fusion.responses,
    failed_models: fusion.failed_models,
    sources,
    usage,
    latency_ms: {
      panel_max: fusion.latency_ms.panel_max,
      judge: fusion.latency_ms.judge,
      synthesis: synthesis.latency_ms,
      end_to_end: endToEnd
    },
    cost_usd: costUsd,
    metadata: {
      ...fusion.metadata,
      cost_source: costReport.cost_source,
      cost_coverage: costReport.cost_coverage,
      provider_generations: generationMetadata
    }
  });
}

export async function runFusionAgentic(
  request: RunRequest,
  options: RunFusionOptions = {}
): Promise<FusionRun> {
  assertResponseFormatSupported(request.response_format);
  assertTextOnlyMessages(request.messages);
  assertTextOnlyMessages(request.context_messages);

  const started = Date.now();
  const createdAt = new Date(started).toISOString();
  const runId = createId("run");
  const traceId = createId("trc");
  let eventSequence = 0;
  const mode = safeModeForRequest(request);
  const preset = FUSION_PRESETS[mode];
  const userPrompt = promptFromMessages(
    request.messages as ChatMessage[] | undefined,
    request.prompt
  );
  const prompt = promptWithContext(
    request.context_messages as ChatMessage[] | undefined,
    userPrompt
  );
  const thread = threadContextForRequest(request);
  const outerModel = outerModelForAgenticRequest(request, preset);
  const panelModels = request.fusion?.panel_models ?? preset.panelModels;
  // Same rule as the direct path: an explicit panel means the judge is exactly
  // what was asked for (optional), never invented from a preset.
  const judgeModel = request.fusion?.panel_models
    ? request.fusion?.judge_model
    : request.fusion?.judge_model ?? preset.judgeModel;
  const effort = request.fusion?.effort;
  const panelConfig = request.fusion?.panel_config;
  const judgeConfig = request.fusion?.judge_config;
  const synthConfig = request.fusion?.synth_config;
  assertBackendsAvailable([
    ...panelModels,
    ...(panelModels.length > 1 && judgeModel ? [judgeModel] : []),
    outerModel
  ]);
  // Same judge rule as assertBackendsAvailable: a single-panel council never
  // runs its judge, so a configured hosted judge must not turn an otherwise
  // harness-only run into a budget-refusable one.
  assertRunWithinBudget([
    ...panelModels,
    ...(panelModels.length > 1 && judgeModel ? [judgeModel] : []),
    outerModel
  ]);
  const maxToolCalls = request.fusion?.max_tool_calls ?? preset.maxToolCalls;
  const outputBudgets = outputBudgetsForRequest(request);
  const temperature = request.fusion?.temperature ?? request.temperature;
  const stopSequences = stopSequencesFrom(request.stop);
  const fusionEnabled = request.fusion?.disabled !== true;
  const strictFusion = request.fusion?.strict === true;
  const localToolsEnabled = strictFusion ? false : preset.localToolsEnabled;
  const webSearch = request.fusion?.web_search;
  const webFetch = request.fusion?.web_fetch;
  const bufferFinalResponse = requiresBufferedResponse(request.response_format);

  async function emit(type: FusionRunEvent["type"], data: FusionRunEvent["data"]) {
    const event: FusionRunEvent = {
      id: createId("evt"),
      object: "fusion.run.event",
      run_id: runId,
      sequence: eventSequence,
      type,
      created_at: new Date().toISOString(),
      data: {
        trace_id: traceId,
        ...data
      }
    };
    eventSequence += 1;
    await options.onEvent?.(event);
  }

  await emit("run.started", {
    mode,
    requested_model: request.model ?? preset.alias,
    outer_model: outerModel,
    thread_id: thread.threadId,
    parent_run_id: thread.parentRunId,
    turn_index: thread.turnIndex,
    agentic_fusion: true,
    fusion_tool: "openrouter:fusion",
    fusion_tool_enabled: fusionEnabled,
    strict_fusion: strictFusion
  });

  await emit("synthesis.started", {
    model: outerModel,
    response_count: 0,
    judge_available: false,
    agentic_fusion: true,
    fusion_tool_enabled: fusionEnabled,
    strict_fusion: strictFusion
  });

  let outer: Awaited<ReturnType<typeof callOuterModelWithFusionTool>>;
  let fusionInvocationCount = 0;
  // Captures the fusion tool's result even when the outer model call later
  // throws — the panel money is spent either way and must reach the ledger.
  let invokedFusionResult: FusionResult | undefined;
  try {
    outer = await callOuterModelWithFusionTool({
      outerModel,
      prompt,
      system: fusionOuterSystemPrompt({
        fusionEnabled,
        responseFormat: request.response_format
      }),
      forceFusion: fusionEnabled && Boolean(request.fusion?.force),
      temperature,
      topP: request.top_p,
      presencePenalty: request.presence_penalty,
      frequencyPenalty: request.frequency_penalty,
      seed: request.seed,
      stopSequences,
      maxOutputTokens: outputBudgets.final,
      effort: nodeEffort(synthConfig, effort),
      signal: options.signal,
      fusionEnabled,
      // Stream the outer model's final answer to the client, just like the direct
      // path — so OpenRouter-style aliases (openrouter/fusion) token-stream too.
      onToken: bufferFinalResponse ? undefined : options.onToken,
      clientTools: request.client_tools,
      clientToolChoice: request.client_tool_choice,
      executeFusion: async (toolPrompt) => {
        const toolStarted = Date.now();
        if (fusionInvocationCount >= 1) {
          const capped = cappedFusionResult({
            prompt: toolPrompt,
            preset,
            panelModels,
            judgeModel,
            outerModel,
            traceId,
            strictFusion,
            thread,
            latencyMs: Date.now() - toolStarted
          });
          await emit("tool.failed", {
            tool: "openrouter:fusion",
            model: outerModel,
            status: capped.status,
            failure_reason: capped.failure_reason,
            latency_ms: capped.latency_ms.end_to_end
          });
          return capped;
        }
        fusionInvocationCount += 1;

        await emit("tool.started", {
          tool: "openrouter:fusion",
          model: outerModel
        });

        try {
          const fusionResult = await runFusionAnalysis({
            prompt: toolPrompt,
            preset,
            panelModels,
            judgeModel,
            outerModel,
            maxToolCalls,
            temperature,
            effort,
            panelConfig,
            judgeConfig,
            synthConfig,
            webSearch,
            webFetch,
            innerMaxOutputTokens: outputBudgets.inner,
            traceId,
            strictFusion,
            thread,
            emit,
            signal: options.signal
          });

          invokedFusionResult = fusionResult;

          await emit("tool.finished", {
            tool: "openrouter:fusion",
            status: fusionResult.status,
            panel_size: fusionResult.metadata.panel_size,
            failed_model_count: fusionResult.failed_models.length,
            cost_usd: fusionResult.cost_usd,
            latency_ms: Date.now() - toolStarted
          });

          return fusionResult;
        } catch (error) {
          await emit("tool.failed", {
            tool: "openrouter:fusion",
            error: error instanceof Error ? error.message : String(error),
            latency_ms: Date.now() - toolStarted
          });
          throw error;
        }
      }
    });

    await emit("synthesis.finished", {
      model: outerModel,
      latency_ms: outer.latency_ms,
      usage: outer.usage,
      source_count: outer.sources.length,
      fusion_invoked: Boolean(outer.fusion_result),
      client_tool_call_count: outer.client_tool_calls.length,
      generation_id: outer.provider_metadata?.generation_id
    });
  } catch (error) {
    await emit("synthesis.failed", {
      model: outerModel,
      error: error instanceof Error ? error.message : String(error)
    });
    // If the fusion tool ran before the outer model failed, its panel money
    // is spent — ledger the partial spend before failing the run.
    if (invokedFusionResult) {
      recordRunSpend({
        id: runId,
        cost_usd: invokedFusionResult.cost_usd,
        metadata: invokedFusionResult.metadata
      });
    }
    throw error;
  }

  const fusionResult = outer.fusion_result;
  const usage = addUsage(fusionResult?.usage ?? emptyUsage(), outer.usage);
  const final = applyStopSequences(outer.text, request.stop);
  const degraded = Boolean(fusionResult?.degraded || fusionResult?.status === "error");
  const generationMetadata = providerGenerations([
    ...(fusionResult?.metadata.provider_generations ?? []),
    outer.provider_metadata
  ]);
  const costReport = providerCostReport(
    generationMetadata,
    (fusionResult?.responses.length ?? 0) +
      (fusionResult?.analysis ? 1 : 0) +
      1
  );
  const costUsd =
    costReport.cost_usd ??
    Number(((fusionResult?.cost_usd ?? 0) + estimateCost(outer.usage, 0)).toFixed(6));

  try {
    assertResponseFormatSatisfied(final, request.response_format);
  } catch (error) {
    // Outer call (and any invoked fusion tool) spent even though the final
    // text misses the response-format contract — ledger before failing. When
    // the fusion tool never ran, the unrecorded spend is a single outer
    // generation; accepted rather than fabricating full run metadata for it.
    if (fusionResult) {
      recordRunSpend({
        id: runId,
        cost_usd: costUsd,
        metadata: {
          ...fusionResult.metadata,
          cost_source: costReport.cost_source,
          cost_coverage: costReport.cost_coverage,
          provider_generations: generationMetadata
        }
      });
    }
    throw error;
  }

  const sources = dedupeSources([
    ...(fusionResult?.sources ?? []),
    ...outer.sources
  ]);
  const completedAt = new Date().toISOString();
  const endToEnd = Date.now() - started;
  const status = "ok";

  await emit("run.completed", {
    status,
    degraded,
    fusion_invoked: Boolean(fusionResult),
    fusion_tool_enabled: fusionEnabled,
    client_tool_call_count: outer.client_tool_calls.length,
    failed_model_count: fusionResult?.failed_models.length ?? 0,
    source_count: sources.length,
    cost_usd: costUsd,
    latency_ms: endToEnd
  });

  return ledgeredRun({
    id: runId,
    object: "fusion.run",
    created_at: createdAt,
    completed_at: completedAt,
    mode,
    requested_model: request.model ?? preset.alias,
    status,
    degraded,
    prompt: userPrompt,
    final,
    analysis: fusionResult?.analysis,
    responses: fusionResult?.responses ?? [],
    failed_models: fusionResult?.failed_models ?? [],
    sources,
    usage,
    latency_ms: {
      panel_max: fusionResult?.latency_ms.panel_max ?? 0,
      judge: fusionResult?.latency_ms.judge ?? 0,
      synthesis: outer.latency_ms,
      end_to_end: endToEnd
    },
    cost_usd: costUsd,
    metadata: {
      trace_id: traceId,
      panel_size: fusionResult?.metadata.panel_size ?? 0,
      panel_models: fusionResult?.metadata.panel_models ?? [],
      // Report the judge that actually ran (or none) — never a preset phantom.
      ...((fusionResult?.metadata.judge_model ?? judgeModel)
        ? { judge_model: fusionResult?.metadata.judge_model ?? judgeModel }
        : {}),
      outer_model: outerModel,
      runtime: runtimeLabel([
        ...(fusionResult?.metadata.panel_models ?? panelModels),
        fusionResult?.metadata.judge_model ?? judgeModel,
        outerModel
      ]),
      fusion_mode: strictFusion ? "strict_openrouter" : "fusion",
      web_enabled: fusionResult?.metadata.web_enabled ?? false,
      web_tools_available: fusionResult?.metadata.web_tools_available ?? false,
      web_fetch_available: fusionResult?.metadata.web_fetch_available ?? false,
      local_tools_enabled: fusionResult?.metadata.local_tools_enabled ?? localToolsEnabled,
      local_tools_available:
        fusionResult?.metadata.local_tools_available ?? (localToolsEnabled && hasLocalTools()),
      judge_web_tools_available:
        fusionResult?.metadata.judge_web_tools_available ?? false,
      outer_web_tools_available: false,
      web_extract_available: preset.webEnabled && hasParallelExtractCredentials(),
      thread_id: thread.threadId,
      parent_run_id: thread.parentRunId,
      turn_index: thread.turnIndex,
      cost_source: costReport.cost_source,
      cost_coverage: costReport.cost_coverage,
      provider_generations: generationMetadata,
      fusion_tool_enabled: fusionEnabled,
      client_tool_calls:
        outer.client_tool_calls.length > 0 ? outer.client_tool_calls : undefined
    }
  });
}
