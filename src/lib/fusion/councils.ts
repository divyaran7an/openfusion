import type { FusionGraph, GraphNode, GraphRole, GraphSource } from "./graph.ts";

export type CouncilPreset = {
  id: string;
  name: string;
  description: string;
  graph: FusionGraph;
};

function now() {
  return "2026-01-01T00:00:00.000Z";
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

function graph(
  id: string,
  name: string,
  nodes: GraphNode[],
  extra: Partial<FusionGraph> = {}
): FusionGraph {
  return {
    object: "fusion.graph",
    id,
    name,
    nodes,
    max_tool_calls: 8,
    updated_at: now(),
    ...extra
  };
}

export const councilPresets: Record<string, CouncilPreset> = {
  "fast-answer": {
    id: "fast-answer",
    name: "Fast Answer",
    description: "One fast model with no judge for low-latency baseline answers.",
    graph: graph(
      "preset-fast-answer",
      "fast-answer",
      [
        node("fast-panel-1", "panel", "gateway", "google/gemini-3.5-flash", { x: 80, y: 160 }, {
          web: true,
          effort: "low"
        }),
        node("fast-synth-1", "synthesizer", "gateway", "google/gemini-3.5-flash", { x: 520, y: 160 }, {
          web: false,
          effort: "low"
        })
      ],
      { max_tool_calls: 4 }
    )
  },
  "budget-council": {
    id: "budget-council",
    name: "Budget Council",
    description: "Three cheaper panels with a mini judge for quality-per-dollar comparisons.",
    graph: graph(
      "preset-budget-council",
      "budget-council",
      [
        node("budget-panel-1", "panel", "gateway", "google/gemini-3.5-flash", { x: 80, y: 80 }, { web: true }),
        node("budget-panel-2", "panel", "gateway", "deepseek/deepseek-v4-flash", { x: 80, y: 260 }, { web: true }),
        node("budget-panel-3", "panel", "gateway", "moonshotai/kimi-k2.6", { x: 80, y: 440 }, { web: true }),
        node("budget-judge-1", "judge", "gateway", "google/gemini-3.5-flash", { x: 520, y: 260 }, {
          web: true,
          effort: "low"
        }),
        node("budget-synth-1", "synthesizer", "gateway", "deepseek/deepseek-v4-flash", { x: 920, y: 260 }, {
          web: false,
          effort: "low"
        })
      ],
      { max_tool_calls: 6 }
    )
  },
  "coding-review": {
    id: "coding-review",
    name: "Coding Review",
    description: "Claude Code and Codex panels with tools on, judged into strict editor-ready output.",
    graph: graph(
      "preset-coding-review",
      "coding-review",
      [
        node("coding-panel-1", "panel", "claude-code", "sonnet", { x: 80, y: 140 }, {
          web: true,
          effort: "medium"
        }),
        node("coding-panel-2", "panel", "codex", "gpt-5.5-codex", { x: 80, y: 340 }, {
          web: true,
          effort: "medium"
        }),
        node("coding-judge-1", "judge", "gateway", "openai/gpt-5.5", { x: 520, y: 240 }, {
          web: true,
          effort: "medium"
        }),
        node("coding-synth-1", "synthesizer", "codex", "gpt-5.5-codex", { x: 920, y: 240 }, {
          web: false,
          effort: "high"
        })
      ],
      { strict: true }
    )
  }
};
