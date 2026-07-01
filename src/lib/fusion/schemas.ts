import { z } from "zod";

export const OpenAIClientToolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string()
  })
});

export const OpenAIClientToolCallDeltaSchema = OpenAIClientToolCallSchema.extend({
  index: z.number().int().nonnegative()
});

export const ChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(z.unknown()), z.null()]).default(""),
  name: z.string().min(1).optional(),
  tool_call_id: z.string().min(1).optional(),
  tool_calls: z.array(OpenAIClientToolCallSchema).optional()
});

export const FusionModeSchema = z.enum([
  "fast",
  "research",
  "fusion-3",
  "fusion-8"
]);

export const FusionModelMetadataSchema = z.object({
  mode: FusionModeSchema,
  aliases: z.array(z.string().min(1)).min(1),
  description: z.string().min(1),
  panel_size: z.number().int().positive(),
  panel_models: z.array(z.string().min(1)).min(1),
  // Omitted when the active council has no judge node.
  judge_model: z.string().min(1).optional(),
  outer_model: z.string().min(1),
  web_enabled: z.boolean(),
  web_fetch_enabled: z.boolean(),
  local_tools_enabled: z.boolean(),
  max_tool_calls: z.number().int().positive().optional()
});

export const FusionModelRecordSchema = z.object({
  id: z.string().min(1),
  object: z.literal("model"),
  created: z.number().int().nonnegative(),
  owned_by: z.literal("fusion"),
  fusion: FusionModelMetadataSchema.required({ max_tool_calls: true })
});

export const FusionModelsResponseSchema = z.object({
  object: z.literal("list"),
  data: z.array(FusionModelRecordSchema)
});

export const FusionHealthModelSchema = FusionModelMetadataSchema.extend({
  id: z.string().min(1)
}).omit({ max_tool_calls: true });

export const HarnessProviderSchema = z.object({
  id: z.enum(["codex", "claude-code"]),
  label: z.string().min(1),
  kind: z.literal("local_harness"),
  enabled: z.boolean(),
  installed: z.boolean(),
  command: z.string().min(1),
  command_path: z.string().min(1).optional(),
  status: z.enum(["ready", "disabled", "missing_command", "configuration_error"]),
  reason: z.string().min(1),
  timeout_ms: z.number().int().positive(),
  scratch_root: z.string().min(1),
  supports: z.object({
    sessions: z.boolean(),
    approvals: z.boolean(),
    events: z.boolean(),
    shell: z.boolean(),
    file_edit: z.boolean(),
    browser: z.boolean()
  })
});

export const FusionHealthSchema = z.object({
  object: z.literal("fusion.health"),
  status: z.enum(["ready", "configuration_required"]),
  runtime: z.object({
    gateway: z.boolean(),
    /** Why the gateway is not connected (failed probe), when applicable. */
    gateway_reason: z.string().optional(),
    gateway_web_search: z.boolean(),
    web_fetch: z.boolean(),
    parallel_extract: z.boolean(),
    local_tools: z.boolean(),
    harnesses: z.array(HarnessProviderSchema),
    store: z.enum(["memory", "redis"]),
    auth_required: z.boolean()
  }),
  endpoints: z.object({
    threads: z.literal("/api/threads"),
    runs: z.literal("/api/runs"),
    run_stream: z.literal("/api/runs/stream"),
    run_events: z.literal("/api/runs/:id/events"),
    chat_completions: z.literal("/v1/chat/completions"),
    models: z.literal("/v1/models")
  }),
  models: z.array(FusionHealthModelSchema)
});

export const FusionStatusSchema = z.enum(["ok", "error"]);

export const FusionRunEventTypeSchema = z.enum([
  "run.started",
  "panel.started",
  "panel.finished",
  "panel.failed",
  "tool.started",
  "tool.finished",
  "tool.failed",
  // A chunk of a node's output text, coalesced server-side, so the studio can
  // show each model typing live in the activity drawer. Carries { role, index?,
  // model, text }.
  "node.delta",
  // Per-node tool activity: a panel/judge/synthesizer model invoked a tool
  // (web search/fetch). `started` is reserved for a future streaming path; the
  // runners report each call once its step settles, as finished or failed.
  // These carry { role, index?, model, tool, call_id, args, result }.
  "node.tool.started",
  "node.tool.finished",
  "node.tool.failed",
  "judge.started",
  "judge.finished",
  "judge.failed",
  "synthesis.started",
  "synthesis.finished",
  "synthesis.failed",
  "run.completed"
]);

export const FusionRunEventSchema = z.object({
  id: z.string().min(1),
  object: z.literal("fusion.run.event"),
  run_id: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  type: FusionRunEventTypeSchema,
  created_at: z.string().datetime(),
  data: z.record(z.string(), z.unknown())
});

export const WebSearchConfigSchema = z.object({
  engine: z
    .enum(["auto", "native", "exa", "firecrawl", "parallel", "perplexity"])
    .optional(),
  max_results: z.number().int().min(1).max(20).optional(),
  max_total_results: z.number().int().min(1).max(100).optional(),
  search_context_size: z.enum(["low", "medium", "high"]).optional(),
  max_characters: z.number().int().min(100).max(200_000).optional(),
  user_location: z.record(z.string(), z.unknown()).optional(),
  allowed_domains: z.array(z.string().min(1)).max(50).optional(),
  excluded_domains: z.array(z.string().min(1)).max(50).optional()
});

export const WebFetchConfigSchema = z.object({
  engine: z
    .enum(["auto", "native", "exa", "openrouter", "firecrawl", "parallel"])
    .optional(),
  max_uses: z.number().int().min(1).max(16).optional(),
  max_content_tokens: z.number().int().min(256).max(125_000).optional(),
  allowed_domains: z.array(z.string().min(1)).max(50).optional(),
  blocked_domains: z.array(z.string().min(1)).max(50).optional()
});

/**
 * Normalized thinking-budget / reasoning effort. Each backend maps this to its
 * own knob: Claude Code `--effort`, Codex `model_reasoning_effort`, and the
 * Vercel AI Gateway reasoning options.
 */
export const EffortSchema = z.enum(["minimal", "low", "medium", "high", "max"]);

/**
 * Per-node runtime config. Each graph node carries its own thinking budget and
 * web-tool toggle, so a cheap panel and a deep synthesizer can run side by side.
 */
export const NodeConfigSchema = z.object({
  effort: EffortSchema.optional(),
  web: z.boolean().optional()
});
export type NodeConfig = z.infer<typeof NodeConfigSchema>;

export const FusionOverrideSchema = z.object({
  panel_models: z.array(z.string().min(1)).min(1).max(8).optional(),
  judge_model: z.string().min(1).optional(),
  outer_model: z.string().min(1).optional(),
  /** Per-node config, index-aligned with `panel_models`. */
  panel_config: z.array(NodeConfigSchema).optional(),
  judge_config: NodeConfigSchema.optional(),
  synth_config: NodeConfigSchema.optional(),
  max_tool_calls: z.number().int().min(1).max(16).optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  effort: EffortSchema.optional(),
  reasoning: z.record(z.string(), z.unknown()).optional(),
  temperature: z.number().min(0).max(2).optional(),
  force: z.boolean().optional(),
  disabled: z.boolean().optional(),
  strict: z.boolean().optional(),
  web_search: WebSearchConfigSchema.optional(),
  web_fetch: WebFetchConfigSchema.optional()
});

export const OpenAIClientFunctionToolSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional()
  })
});

export const RunRequestSchema = z.object({
  prompt: z.string().min(1).optional(),
  messages: z.array(ChatMessageSchema).optional(),
  context_messages: z.array(ChatMessageSchema).optional(),
  mode: FusionModeSchema.default("fusion-3"),
  model: z.string().optional(),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  thread_id: z.string().min(1).optional(),
  parent_run_id: z.string().min(1).optional(),
  turn_index: z.number().int().nonnegative().optional(),
  fusion: FusionOverrideSchema.optional(),
  client_tools: z.array(OpenAIClientFunctionToolSchema).optional(),
  client_tool_choice: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
}).refine(
  (value) =>
    Boolean(value.prompt?.trim()) ||
    Boolean(
      value.messages?.some(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.trim().length > 0
      )
    ),
  {
    message: "A Fusion run needs a non-empty prompt or user message."
  }
);

export const OpenAIChatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(ChatMessageSchema).min(1),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  tools: z.array(z.record(z.string(), z.unknown())).optional(),
  tool_choice: z.unknown().optional(),
  plugins: z.array(z.record(z.string(), z.unknown())).optional(),
  reasoning: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const OpenAICompletionUsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative()
});

export const ProviderCallMetadataSchema = z.object({
  model: z.string().optional(),
  provider: z.string().optional(),
  generation_id: z.string().optional(),
  request_id: z.string().optional(),
  response_id: z.string().optional(),
  response_model: z.string().optional(),
  timestamp: z.string().optional(),
  total_cost_usd: z.number().nonnegative().optional(),
  upstream_inference_cost_usd: z.number().nonnegative().optional(),
  usage_cost_usd: z.number().nonnegative().optional(),
  provider_name: z.string().optional(),
  is_byok: z.boolean().optional(),
  streamed: z.boolean().optional(),
  finish_reason: z.string().optional(),
  latency_ms: z.number().nonnegative().optional(),
  generation_time_ms: z.number().nonnegative().optional(),
  prompt_tokens: z.number().int().nonnegative().optional(),
  completion_tokens: z.number().int().nonnegative().optional(),
  reasoning_tokens: z.number().int().nonnegative().optional(),
  cached_tokens: z.number().int().nonnegative().optional(),
  cache_creation_tokens: z.number().int().nonnegative().optional(),
  billable_web_search_calls: z.number().int().nonnegative().optional()
});

export const CostCoverageSchema = z.object({
  expected_provider_calls: z.number().int().nonnegative(),
  priced_provider_calls: z.number().int().nonnegative(),
  missing_provider_calls: z.number().int().nonnegative(),
  coverage_ratio: z.number().min(0).max(1)
});

const OpenAICompletionFusionMetadataSchema = z.object({
  run_id: z.string().min(1),
  status: FusionStatusSchema,
  degraded: z.boolean(),
  mode: FusionModeSchema,
  trace_id: z.string().min(1).optional(),
  panel_size: z.number().int().nonnegative().optional(),
  cost_usd: z.number().nonnegative().optional(),
  cost_source: z.enum(["estimate", "gateway_generation"]).optional(),
  cost_coverage: CostCoverageSchema.optional(),
  provider_generations: z.array(ProviderCallMetadataSchema).optional(),
  client_tool_calls: z.array(OpenAIClientToolCallSchema).optional(),
  latency_ms: z
    .object({
      panel_max: z.number().int().nonnegative(),
      judge: z.number().int().nonnegative(),
      synthesis: z.number().int().nonnegative(),
      end_to_end: z.number().int().nonnegative()
    })
    .optional()
});

export const OpenAIChatCompletionResponseSchema = z.object({
  id: z.string().min(1),
  object: z.literal("chat.completion"),
  created: z.number().int().nonnegative(),
  model: z.string().min(1),
  choices: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      message: z.object({
        role: z.literal("assistant"),
        content: z.string().nullable(),
        tool_calls: z.array(OpenAIClientToolCallSchema).optional()
      }),
      finish_reason: z.enum(["stop", "error", "tool_calls"])
    })
  ),
  usage: OpenAICompletionUsageSchema,
  fusion: OpenAICompletionFusionMetadataSchema.required({
    trace_id: true,
    panel_size: true,
    cost_usd: true,
    latency_ms: true
  })
});

export const OpenAIChatCompletionChunkSchema = z.object({
  id: z.string().min(1),
  object: z.literal("chat.completion.chunk"),
  created: z.number().int().nonnegative(),
  model: z.string().min(1),
  choices: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      delta: z.object({
        role: z.literal("assistant").optional(),
        content: z.string().optional(),
        tool_calls: z.array(OpenAIClientToolCallDeltaSchema).optional()
      }),
      finish_reason: z.enum(["stop", "error", "tool_calls"]).nullable()
    })
  ),
  fusion: OpenAICompletionFusionMetadataSchema.optional(),
  fusion_event: FusionRunEventSchema.optional()
});

export const AnalysisSchema = z.object({
  consensus: z.array(z.string()),
  contradictions: z.array(
    z.object({
      topic: z.string(),
      stances: z.array(
        z.object({
          model: z.string(),
          stance: z.string()
        })
      )
    })
  ),
  partial_coverage: z.array(
    z.object({
      models: z.array(z.string()),
      point: z.string()
    })
  ),
  unique_insights: z.array(
    z.object({
      model: z.string(),
      insight: z.string()
    })
  ),
  blind_spots: z.array(z.string())
});

export const FailureReasonSchema = z.enum([
  "all_panels_failed",
  "insufficient_credits",
  "rate_limited",
  "fusion_invocation_capped",
  "provider_timeout",
  "invalid_judge_json",
  "recursion_blocked",
  "policy_blocked",
  "unexpected_error"
]);

export const SourceRecordSchema = z.object({
  title: z.string().optional(),
  url: z.string().optional(),
  snippet: z.string().optional(),
  provider: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const UsageRecordSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative()
});

export const PanelResponseSchema = z.object({
  model: z.string().min(1),
  role: z.string().min(1),
  content: z.string(),
  usage: UsageRecordSchema,
  sources: z.array(SourceRecordSchema),
  latency_ms: z.number().int().nonnegative(),
  provider_metadata: ProviderCallMetadataSchema.optional()
});

export const FailedModelSchema = z.object({
  model: z.string().min(1),
  error: z.string(),
  failure_reason: FailureReasonSchema.optional()
});

export const FusionRunMetadataSchema = z.object({
  trace_id: z.string().min(1),
  panel_size: z.number().int().nonnegative(),
  panel_models: z.array(z.string()),
  // Omitted when the council has no judge node — the synthesizer then works
  // straight from the raw panel answers. No judge is ever invented.
  judge_model: z.string().min(1).optional(),
  outer_model: z.string().min(1),
  runtime: z.enum(["gateway", "harness", "mixed"]),
  fusion_mode: z.enum(["strict_openrouter", "fusion"]).optional(),
  web_enabled: z.boolean(),
  web_tools_available: z.boolean(),
  web_fetch_available: z.boolean(),
  local_tools_enabled: z.boolean(),
  local_tools_available: z.boolean(),
  judge_web_tools_available: z.boolean(),
  outer_web_tools_available: z.boolean(),
  web_extract_available: z.boolean(),
  fusion_tool_enabled: z.boolean().optional(),
  thread_id: z.string().min(1).optional(),
  parent_run_id: z.string().min(1).optional(),
  turn_index: z.number().int().nonnegative().optional(),
  cost_source: z.enum(["estimate", "gateway_generation"]).optional(),
  cost_coverage: CostCoverageSchema.optional(),
  provider_generations: z.array(ProviderCallMetadataSchema).optional(),
  client_tool_calls: z.array(OpenAIClientToolCallSchema).optional()
});

export const FusionRunSchema = z.object({
  id: z.string().min(1),
  object: z.literal("fusion.run"),
  created_at: z.string().datetime(),
  completed_at: z.string().datetime(),
  mode: FusionModeSchema,
  requested_model: z.string().min(1),
  status: FusionStatusSchema,
  degraded: z.boolean(),
  failure_reason: FailureReasonSchema.optional(),
  prompt: z.string(),
  final: z.string(),
  analysis: AnalysisSchema.optional(),
  responses: z.array(PanelResponseSchema),
  failed_models: z.array(FailedModelSchema),
  sources: z.array(SourceRecordSchema),
  usage: UsageRecordSchema,
  latency_ms: z.object({
    panel_max: z.number().int().nonnegative(),
    judge: z.number().int().nonnegative(),
    synthesis: z.number().int().nonnegative(),
    end_to_end: z.number().int().nonnegative()
  }),
  cost_usd: z.number().nonnegative(),
  metadata: FusionRunMetadataSchema
});

export const FusionThreadSchema = z.object({
  id: z.string().min(1),
  object: z.literal("fusion.thread"),
  title: z.string().min(1),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  archived: z.boolean(),
  run_count: z.number().int().nonnegative(),
  first_run_id: z.string().min(1).optional(),
  latest_run_id: z.string().min(1).optional(),
  latest_prompt: z.string().optional(),
  latest_mode: FusionModeSchema.optional(),
  latest_status: FusionStatusSchema.optional(),
  total_cost_usd: z.number().nonnegative(),
  total_latency_ms: z.number().int().nonnegative()
});

export const FusionThreadsResponseSchema = z.object({
  object: z.literal("list"),
  data: z.array(FusionThreadSchema)
});

export const FusionThreadDetailSchema = z.object({
  object: z.literal("fusion.thread.detail"),
  thread: FusionThreadSchema,
  runs: z.array(FusionRunSchema)
});

export const FusionResultSchema = z.object({
  object: z.literal("fusion.result"),
  status: FusionStatusSchema,
  degraded: z.boolean(),
  failure_reason: FailureReasonSchema.optional(),
  prompt: z.string(),
  analysis: AnalysisSchema.optional(),
  responses: z.array(PanelResponseSchema),
  failed_models: z.array(FailedModelSchema),
  sources: z.array(SourceRecordSchema),
  usage: UsageRecordSchema,
  latency_ms: z.object({
    panel_max: z.number().int().nonnegative(),
    judge: z.number().int().nonnegative(),
    end_to_end: z.number().int().nonnegative()
  }),
  cost_usd: z.number().nonnegative(),
  metadata: FusionRunMetadataSchema
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type FusionMode = z.infer<typeof FusionModeSchema>;
export type FusionModelMetadata = z.infer<typeof FusionModelMetadataSchema>;
export type FusionModelRecord = z.infer<typeof FusionModelRecordSchema>;
export type FusionModelsResponse = z.infer<typeof FusionModelsResponseSchema>;
export type FusionHealth = z.infer<typeof FusionHealthSchema>;
export type HarnessProvider = z.infer<typeof HarnessProviderSchema>;
export type WebSearchConfig = z.infer<typeof WebSearchConfigSchema>;
export type WebFetchConfig = z.infer<typeof WebFetchConfigSchema>;
export type FusionOverride = z.infer<typeof FusionOverrideSchema>;
export type EffortLevel = z.infer<typeof EffortSchema>;
export type RunRequest = z.infer<typeof RunRequestSchema>;
export type OpenAIChatCompletionRequest = z.infer<
  typeof OpenAIChatCompletionRequestSchema
>;
export type OpenAIClientFunctionTool = z.infer<
  typeof OpenAIClientFunctionToolSchema
>;
export type OpenAIClientToolCall = z.infer<typeof OpenAIClientToolCallSchema>;
export type OpenAIChatCompletionResponse = z.infer<
  typeof OpenAIChatCompletionResponseSchema
>;
export type OpenAIChatCompletionChunk = z.infer<
  typeof OpenAIChatCompletionChunkSchema
>;
export type FusionAnalysis = z.infer<typeof AnalysisSchema>;
export type FusionStatus = z.infer<typeof FusionStatusSchema>;
export type FailureReason = z.infer<typeof FailureReasonSchema>;
export type SourceRecord = z.infer<typeof SourceRecordSchema>;
export type UsageRecord = z.infer<typeof UsageRecordSchema>;
export type ProviderCallMetadata = z.infer<typeof ProviderCallMetadataSchema>;
export type CostCoverage = z.infer<typeof CostCoverageSchema>;
export type PanelResponse = z.infer<typeof PanelResponseSchema>;
export type FailedModel = z.infer<typeof FailedModelSchema>;
export type FusionRunMetadata = z.infer<typeof FusionRunMetadataSchema>;
export type FusionRunEventType = z.infer<typeof FusionRunEventTypeSchema>;
export type FusionRunEvent = z.infer<typeof FusionRunEventSchema>;
export type FusionRun = z.infer<typeof FusionRunSchema>;
export type FusionThread = z.infer<typeof FusionThreadSchema>;
export type FusionThreadsResponse = z.infer<typeof FusionThreadsResponseSchema>;
export type FusionThreadDetail = z.infer<typeof FusionThreadDetailSchema>;
export type FusionResult = z.infer<typeof FusionResultSchema>;
