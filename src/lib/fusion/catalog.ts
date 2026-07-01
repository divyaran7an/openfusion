import { getActiveGraph } from "./graph-store.ts";
import { graphToOverride, nodeModelId, validateGraph } from "./graph.ts";
import {
  FusionHealthSchema,
  FusionModelsResponseSchema,
  type FusionHealth,
  type HarnessProvider,
  type FusionModelsResponse
} from "./schemas.ts";

/**
 * The one model Fusion advertises: the user's active graph. An IDE/CLI calls it
 * by name (the graph's `name`, "fusion" by default) and the panel → judge →
 * synthesizer council that's currently on the canvas runs. The `fusion` block is
 * a non-standard extension (OpenAI clients ignore it) describing what will run.
 */
function activeGraphModel(options: { created: number; webFetchAvailable: boolean }) {
  const graph = getActiveGraph();
  const panels = graph.nodes.filter((node) => node.role === "panel");
  const judge = graph.nodes.find((node) => node.role === "judge");
  const synth = graph.nodes.find((node) => node.role === "synthesizer");
  const runnable = validateGraph(graph).ok;
  const override = runnable ? graphToOverride(graph) : undefined;
  const webEnabled = graph.nodes.some((node) => node.web);
  // The model record stays well-formed even if the graph is mid-edit (no panel
  // yet), so an IDE polling /v1/models never sees a 500.
  const panelModels = override?.panel_models ??
    (panels.length > 0 ? panels.map(nodeModelId) : [graph.name]);

  return {
    id: graph.name,
    created: options.created,
    fusion: {
      mode: "fusion-3" as const,
      aliases: ["openfusion", "fusion", "fusion/fusion", "openrouter/fusion"],
      description:
        "Runs your active OpenFusion council — panel models answer in parallel, an optional judge compares them, and the synthesizer writes the final answer.",
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
    data: [{ ...model, object: "model", owned_by: "fusion" }]
  });
}

export function healthPayload(
  capabilities: FusionRuntimeCapabilities
): FusionHealth {
  return FusionHealthSchema.parse({
    object: "fusion.health",
    status: capabilities.gateway ? "ready" : "configuration_required",
    runtime: {
      gateway: capabilities.gateway,
      ...(capabilities.gatewayReason ? { gateway_reason: capabilities.gatewayReason } : {}),
      gateway_web_search: capabilities.gatewayWebSearch,
      web_fetch: capabilities.webFetch,
      parallel_extract: capabilities.parallelExtract,
      local_tools: capabilities.localTools,
      harnesses: capabilities.harnesses,
      store: capabilities.store,
      auth_required: capabilities.authRequired
    },
    endpoints: {
      threads: "/api/threads",
      runs: "/api/runs",
      run_stream: "/api/runs/stream",
      run_events: "/api/runs/:id/events",
      chat_completions: "/v1/chat/completions",
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
