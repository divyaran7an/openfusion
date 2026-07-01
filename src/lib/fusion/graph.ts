import { z } from "zod";
import { EffortSchema, FusionOverrideSchema, type FusionOverride } from "./schemas.ts";

/**
 * The Fusion graph is the entire product config.
 *
 * There are no modes, presets, or aliases. A user composes one graph on the
 * canvas: panel nodes that answer in parallel, an optional judge that compares
 * them, and a synthesizer that writes the final answer. The OpenAI-compatible
 * endpoint runs *that graph* for every request. Edit the graph, and the next call
 * uses the new wiring. Nothing to redeploy.
 *
 * Each node is a (source x model): Vercel AI Gateway, OpenRouter, Claude Code,
 * or Codex.
 */

export const GraphSourceSchema = z.enum(["gateway", "openrouter", "claude-code", "codex"]);
export type GraphSource = z.infer<typeof GraphSourceSchema>;

export const GraphRoleSchema = z.enum(["panel", "judge", "synthesizer"]);
export type GraphRole = z.infer<typeof GraphRoleSchema>;

export const GraphNodeSchema = z.object({
  id: z.string().min(1),
  role: GraphRoleSchema,
  source: GraphSourceSchema,
  /** Source-local model id, e.g. "anthropic/claude-opus-4.8", "opus", "gpt-5.5". */
  model: z.string().min(1),
  /** Per-node thinking budget. */
  effort: EffortSchema.optional(),
  /** Per-node web tools (search + fetch). */
  web: z.boolean().optional(),
  label: z.string().optional(),
  position: z.object({ x: z.number(), y: z.number() })
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const FusionGraphSchema = z.object({
  object: z.literal("fusion.graph"),
  id: z.string().min(1),
  /** The model id external clients call (e.g. "fusion"). */
  name: z.string().min(1),
  nodes: z.array(GraphNodeSchema),
  /** Global tool budget for any node that has web/local tools enabled. */
  max_tool_calls: z.number().int().min(1).max(16).default(8),
  /** Sampling temperature for the panel and synthesizer (the judge is always 0). */
  temperature: z.number().min(0).max(2).optional(),
  /**
   * Strict OpenRouter-Fusion mode: panels run with no local tools, the council
   * pipeline is forced, and the synthesizer answers only from the analysis.
   */
  strict: z.boolean().optional(),
  updated_at: z.string()
});
export type FusionGraph = z.infer<typeof FusionGraphSchema>;

/** Resolve a node to the runtime model id the orchestrator routes on. */
export function nodeModelId(node: Pick<GraphNode, "source" | "model">) {
  return node.source === "gateway" ? node.model : `${node.source}/${node.model}`;
}

export function defaultWebForRole(role: GraphRole) {
  return role !== "synthesizer";
}

function nodeWeb(node: Pick<GraphNode, "role" | "web">) {
  return node.web ?? defaultWebForRole(node.role);
}

export type GraphValidation = { ok: boolean; errors: string[] };

/** A runnable graph needs at least one panel node and exactly one synthesizer. */
export function validateGraph(graph: FusionGraph): GraphValidation {
  const errors: string[] = [];
  const panels = graph.nodes.filter((node) => node.role === "panel");
  const judges = graph.nodes.filter((node) => node.role === "judge");
  const synths = graph.nodes.filter((node) => node.role === "synthesizer");

  if (panels.length === 0) {
    errors.push("Add at least one panel model. The council needs voices to deliberate.");
  }
  if (synths.length === 0) {
    errors.push("Add a synthesizer. One model has to write the final answer.");
  }
  if (synths.length > 1) {
    errors.push("Only one synthesizer can write the final answer.");
  }
  if (judges.length > 1) {
    errors.push("Only one judge can compare the panel.");
  }
  // A node with no model can't run, for example "Custom ID" left blank, or a panel still on
  // "Choose a model". Catch it on the canvas instead of firing a doomed request.
  if (graph.nodes.some((node) => node.model.trim() === "")) {
    errors.push('Every node needs a model. Finish the ones still marked "Choose a model".');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Convert the graph into the run override the orchestrator already understands
 * (panel/judge/outer model ids + tools + effort). The execution engine,
 * harness routing, panel -> judge -> synth, cost/provenance, is reused unchanged.
 */
export function graphToOverride(graph: FusionGraph): FusionOverride {
  const panels = graph.nodes.filter((node) => node.role === "panel");
  const judge = graph.nodes.find((node) => node.role === "judge");
  const synth = graph.nodes.find((node) => node.role === "synthesizer");

  if (panels.length === 0 || !synth) {
    throw new Error("Graph is not runnable: it needs a panel and a synthesizer.");
  }

  const selectedPanels = panels.slice(0, 8);
  const anyWeb = graph.nodes.some(nodeWeb);

  return FusionOverrideSchema.parse({
    panel_models: selectedPanels.map(nodeModelId),
    judge_model: judge ? nodeModelId(judge) : undefined,
    outer_model: nodeModelId(synth),
    // Each node carries its own thinking budget and web toggle; the orchestrator
    // applies them per call so a cheap panel and a deep synthesizer coexist.
    panel_config: selectedPanels.map((node) => ({ effort: node.effort, web: nodeWeb(node) })),
    judge_config: judge ? { effort: judge.effort, web: nodeWeb(judge) } : undefined,
    synth_config: { effort: synth.effort, web: nodeWeb(synth) },
    max_tool_calls: graph.max_tool_calls,
    temperature: graph.temperature,
    // Back-compat fallback effort for any call without a per-node override.
    effort: synth.effort ?? panels[0]?.effort,
    // Tool *configs* must be present for web tools to attach; per-node `web`
    // flags then gate whether each call actually receives them.
    web_search: anyWeb ? {} : undefined,
    web_fetch: anyWeb ? {} : undefined,
    strict: graph.strict ?? false,
    force: true
  });
}

function node(
  id: string,
  role: GraphRole,
  source: GraphSource,
  model: string,
  position: { x: number; y: number },
  extra: Partial<GraphNode> = {}
): GraphNode {
  return { id, role, source, model, position, ...extra };
}

/**
 * The seed graph the canvas opens with, never a blank page. A small Vercel AI Gateway
 * council the user immediately rewires. Not a template system; just a starting
 * state. Defaults use current frontier models.
 */
export function defaultGraph(updatedAt: string): FusionGraph {
  return {
    object: "fusion.graph",
    id: "active",
    name: "openfusion",
    max_tool_calls: 8,
    updated_at: updatedAt,
    // Follows the OpenRouter Fusion quality shape: three distinct hosted-model
    // families answer in parallel with web tools, a judge compares them with web
    // on and temperature 0, and the synthesizer writes the final answer.
    nodes: [
      node("panel-1", "panel", "gateway", "anthropic/claude-opus-4.8", { x: 80, y: 80 }, { web: true }),
      node("panel-2", "panel", "gateway", "openai/gpt-5.5", { x: 80, y: 260 }, { web: true }),
      node("panel-3", "panel", "gateway", "google/gemini-3.1-pro-preview", { x: 80, y: 440 }, { web: true }),
      node("judge-1", "judge", "gateway", "openai/gpt-5.5", { x: 520, y: 200 }, { web: true }),
      node("synth-1", "synthesizer", "gateway", "anthropic/claude-opus-4.8", { x: 920, y: 260 }, {
        effort: "high"
      })
    ]
  };
}
