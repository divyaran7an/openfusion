import { budgetStatus } from "./budget.ts";
import { getActiveGraph } from "./graph-store.ts";
import { defaultWebForRole, graphToOverride, nodeModelId, validateGraph } from "./graph.ts";
import { requiredBackends } from "./model-routing.ts";
import { publicModelAliases } from "./models.ts";
import {
  FusionModelRecordSchema,
  FusionHealthSchema,
  FusionModelsResponseSchema,
  type FusionHealth,
  type HarnessProvider,
  type FusionModelsResponse
} from "./schemas.ts";

/**
 * The callable model OpenFusion advertises: the user's active graph. IDEs and
 * CLIs may call it by the graph name or any compatibility alias; every id points
 * at the same panel → judge → synthesizer council currently on the canvas. The
 * `fusion` block is a non-standard extension (OpenAI clients ignore it)
 * describing what will run.
 */
function activeGraphModel(options: { created: number; webFetchAvailable: boolean }) {
  const graph = getActiveGraph();
  const panels = graph.nodes.filter((node) => node.role === "panel");
  const judge = graph.nodes.find((node) => node.role === "judge");
  const synth = graph.nodes.find((node) => node.role === "synthesizer");
  const runnable = validateGraph(graph).ok;
  const override = runnable ? graphToOverride(graph) : undefined;
  const webEnabled = graph.nodes.some((node) => node.web ?? defaultWebForRole(node.role));
  // The model record stays well-formed even if the graph is mid-edit (no panel
  // yet), so an IDE polling /v1/models never sees a 500.
  const panelModels = override?.panel_models ??
    (panels.length > 0 ? panels.map(nodeModelId) : [graph.name]);
  const aliases = Array.from(new Set([graph.name, ...publicModelAliases()]));

  return {
    id: graph.name,
    created: options.created,
    fusion: {
      mode: "openfusion" as const,
      aliases,
      description:
        "Runs your active OpenFusion council: panel models answer in parallel, an optional judge compares them, and the synthesizer writes the final answer.",
      panel_size: panelModels.length,
      panel_models: panelModels,
      judge_model: override?.judge_model ?? (judge ? nodeModelId(judge) : undefined),
      outer_model:
        override?.outer_model ?? (synth ? nodeModelId(synth) : graph.name),
      web_enabled: webEnabled,
      web_fetch_enabled: webEnabled && options.webFetchAvailable,
      local_tools_enabled: true,
      max_tool_calls: graph.max_tool_calls
    }
  };
}

export type FusionRuntimeCapabilities = {
  gateway: boolean;
  gatewayReason?: string;
  gatewayWebSearch: boolean;
  openrouter: boolean;
  openrouterReason?: string;
  openrouterWebSearch: boolean;
  webFetch: boolean;
  parallelExtract: boolean;
  localTools: boolean;
  harnesses: HarnessProvider[];
  store: "memory" | "redis";
  authRequired: boolean;
};

export function modelRecords(
  options: {
    created?: number;
    webFetchAvailable: boolean;
  }
): FusionModelsResponse {
  const created = options.created ?? Math.floor(Date.now() / 1000);
  const model = activeGraphModel({ created, webFetchAvailable: options.webFetchAvailable });

  return FusionModelsResponseSchema.parse({
    object: "list",
    data: model.fusion.aliases.map((id) => ({
      ...model,
      id,
      object: "model",
      owned_by: "fusion"
    }))
  });
}

/**
 * OpenAI-compatible model retrieval. Chat completion calls intentionally accept
 * any model id and route the active graph; retrieving a model should be just as
 * permissive so clients that preflight their selected slug do not fail before
 * the first request.
 */
export function modelRecord(
  modelId: string,
  options: {
    created?: number;
    webFetchAvailable: boolean;
  }
) {
  const requested = modelId.trim();
  const fallback = activeGraphModel({
    created: options.created ?? Math.floor(Date.now() / 1000),
    webFetchAvailable: options.webFetchAvailable
  });

  return FusionModelRecordSchema.parse({
    ...fallback,
    id: requested || fallback.id,
    object: "model",
    owned_by: "fusion"
  });
}

export function healthPayload(
  capabilities: FusionRuntimeCapabilities
): FusionHealth {
  const activeGraphReady = (() => {
    const graph = getActiveGraph();
    if (!validateGraph(graph).ok) {
      return false;
    }

    let override: ReturnType<typeof graphToOverride>;
    try {
      override = graphToOverride(graph);
    } catch {
      return false;
    }

    const required = requiredBackends([
      ...(override.panel_models ?? []),
      override.judge_model,
      override.outer_model
    ]);
    const readyHarnesses = new Set(
      capabilities.harnesses
        .filter((harness) => harness.status === "ready")
        .map((harness) => harness.id)
    );

    return (
      (!required.gateway || capabilities.gateway) &&
      (!required.openrouter || capabilities.openrouter) &&
      required.harnesses.every((harness) => readyHarnesses.has(harness))
    );
  })();

  return FusionHealthSchema.parse({
    object: "fusion.health",
    status: activeGraphReady ? "ready" : "configuration_required",
    runtime: {
      gateway: capabilities.gateway,
      ...(capabilities.gatewayReason ? { gateway_reason: capabilities.gatewayReason } : {}),
      gateway_web_search: capabilities.gatewayWebSearch,
      openrouter: capabilities.openrouter,
      ...(capabilities.openrouterReason
        ? { openrouter_reason: capabilities.openrouterReason }
        : {}),
      openrouter_web_search: capabilities.openrouterWebSearch,
      web_fetch: capabilities.webFetch,
      parallel_extract: capabilities.parallelExtract,
      local_tools: capabilities.localTools,
      harnesses: capabilities.harnesses,
      store: capabilities.store,
      auth_required: capabilities.authRequired
    },
    budget: budgetStatus(),
    endpoints: {
      threads: "/api/threads",
      runs: "/api/runs",
      run_stream: "/api/runs/stream",
      run_events: "/api/runs/:id/events",
      chat_completions: "/v1/chat/completions",
      responses: "/v1/responses",
      models: "/v1/models"
    },
    models: [
      (() => {
        const model = activeGraphModel({
          created: Math.floor(Date.now() / 1000),
          webFetchAvailable: capabilities.webFetch
        });
        return { id: model.id, ...model.fusion };
      })()
    ]
  });
}
