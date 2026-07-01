"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeChange
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  validateGraph,
  type FusionGraph,
  type GraphNode,
  type GraphRole,
  type GraphSource
} from "@/lib/fusion/graph";
import type { FusionRunEvent } from "@/lib/fusion/types";
import {
  reduceActivity,
  type ActivityNode,
  type ActivityTool
} from "@/lib/fusion/activity-log";

/* ─── design tokens ─────────────────────────────────────────────────────── */

const SOURCE: Record<GraphSource, { label: string; color: string; hint: string }> = {
  gateway: { label: "Gateway", color: "#c7b79d", hint: "provider/model" },
  "claude-code": { label: "Claude Code", color: "#d9895f", hint: "opus · sonnet · haiku" },
  codex: { label: "Codex", color: "#5db89a", hint: "gpt-5.5" }
};

const ROLE: Record<GraphRole, { label: string; blurb: string }> = {
  panel: { label: "Panel", blurb: "answers in parallel" },
  judge: { label: "Judge", blurb: "compares · temp 0" },
  synthesizer: { label: "Synthesizer", blurb: "writes the final answer" }
};

const EFFORTS = ["minimal", "low", "medium", "high", "max"] as const;


// Pick a model, don't type one. Curated real ids per source; "Custom…" still
// lets power users paste any id the source accepts.
// An opinionated, current shortlist of Gateway models (verified ids — picking one
// the Gateway doesn't serve is what produces an empty "No output" run). The first
// three are distinct frontier families and make the default Quality panel. Any
// other id the Gateway accepts still works via "Custom…".
const MODEL_CATALOG: Record<GraphSource, string[]> = {
  gateway: [
    "anthropic/claude-opus-4.8",
    "openai/gpt-5.5",
    "google/gemini-3-pro-preview",
    "anthropic/claude-sonnet-4.6",
    "deepseek/deepseek-v4-pro",
    "google/gemini-3.5-flash",
    "deepseek/deepseek-v4-flash",
    "alibaba/qwen3.7-max"
  ],
  // Claude Code aliases: opus → Opus 4.8, sonnet → Sonnet 4.6, haiku → Haiku 4.5.
  "claude-code": ["opus", "sonnet", "haiku"],
  // GPT-5.5 is Codex's current default; the -codex variant is coding-tuned.
  codex: ["gpt-5.5", "gpt-5.5-codex", "gpt-5.4"]
};

const CUSTOM_MODEL = "__custom__";

// How each source connects. No secrets are ever typed into the canvas — the
// panel shows live status and the exact local step to wire it up.
const SOURCE_SETUP: Record<
  GraphSource,
  { blurb: string; steps: { label: string; code?: string }[]; link?: { label: string; href: string }; models: string }
> = {
  gateway: {
    blurb: "One key, every frontier model — billed per token through Vercel AI Gateway. Paste it below; it's saved locally and used right away.",
    steps: [],
    link: { label: "Get a key", href: "https://vercel.com/docs/ai-gateway" },
    models: "Use provider/model ids, e.g. openai/gpt-5.5"
  },
  "claude-code": {
    blurb: "Run Claude on your Pro/Max subscription via the local CLI — no API bill. Sign in once and it connects automatically.",
    steps: [
      { label: "Install the Claude Code CLI and sign in:", code: "claude" },
      { label: "Hit Recheck — that's it." }
    ],
    models: "Models: opus · sonnet · haiku"
  },
  codex: {
    blurb: "Run Codex on your ChatGPT subscription via the local CLI — no API bill. Sign in once and it connects automatically.",
    steps: [
      { label: "Install the Codex CLI and sign in:", code: "codex" },
      { label: "Hit Recheck — that's it." }
    ],
    models: "Models: gpt-5.5 · gpt-5.5-codex"
  }
};

/* ─── node data ─────────────────────────────────────────────────────────── */

type NodeStatus = "idle" | "running" | "done" | "failed";

// One message in the studio's conversation. We keep only what the council does
// across turns: the user's question and the synthesizer's grounded final answer —
// never the raw panel internals, which are re-derived fresh each turn (the panel
// is blind and re-runs every turn; the conversation is the only carried state).
type ChatTurn = {
  id: string;
  role: "user" | "assistant";
  content: string;
  error?: boolean;
  cost?: number;
  latency?: number;
};

type StudioNodeData = {
  node: GraphNode;
  status: NodeStatus;
  onChange: (id: string, patch: Partial<GraphNode>) => void;
  onRemove: (id: string) => void;
};

// The OpenFusion mark: three sources converging into one — the council → synthesis
// pipeline as a glyph. Inherits the brand color via currentColor.
// A solid app-icon mark: a warm rounded tile with a bold dark convergence glyph
// (three sources → one synthesis). Reads cleanly at header size where thin lines
// would vanish.
function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 28 28" width="26" height="26" aria-hidden="true">
      <defs>
        <linearGradient id="ofMark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ecd9b9" />
          <stop offset="1" stopColor="#c5b395" />
        </linearGradient>
      </defs>
      <rect width="28" height="28" rx="8.5" fill="url(#ofMark)" />
      <g stroke="#1a1712" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity="0.9">
        <path d="M9 9.5 L15.6 14 L9 18.5" />
        <path d="M9 14 H15.6" />
      </g>
      <g fill="#1a1712">
        <circle cx="9" cy="9.5" r="1.5" />
        <circle cx="9" cy="14" r="1.5" />
        <circle cx="9" cy="18.5" r="1.5" />
        <circle cx="16.8" cy="14" r="2.7" />
      </g>
    </svg>
  );
}

// Pick a model from the source's catalog, or choose "Custom…" to type any id
// the source accepts. Kept as its own component so the node body stays readable.
function ModelField({
  node,
  onChange
}: {
  node: GraphNode;
  onChange: StudioNodeData["onChange"];
}) {
  const source = SOURCE[node.source] ?? SOURCE.gateway;
  const catalog = MODEL_CATALOG[node.source] ?? [];
  const isCustom = node.model !== "" && !catalog.includes(node.model);
  return (
    <>
      <select
        className="fnode-model nodrag nopan"
        aria-label="Model"
        value={isCustom ? CUSTOM_MODEL : node.model}
        onChange={(event) => {
          const value = event.target.value;
          onChange(node.id, { model: value === CUSTOM_MODEL ? "" : value });
        }}
      >
        {node.model === "" ? <option value="">Choose a model…</option> : null}
        {catalog.map((model) => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
        <option value={CUSTOM_MODEL}>Custom…</option>
      </select>
      {isCustom || node.model === "" ? (
        <input
          className="fnode-model-custom nodrag nopan"
          value={node.model}
          spellCheck={false}
          placeholder={source.hint}
          aria-label="Custom model id"
          onChange={(event) => onChange(node.id, { model: event.target.value })}
        />
      ) : null}
    </>
  );
}

function FusionNode({ data, selected }: NodeProps<Node<StudioNodeData>>) {
  const { node, status, onChange, onRemove } = data;
  const source = SOURCE[node.source] ?? SOURCE.gateway;

  return (
    <div className={`fnode fnode-${node.role} status-${status} ${selected ? "selected" : ""}`}>
      {/* Edges are derived from role, not drawn by hand — the ports are status
          dots, not connection targets, so they're non-interactive. */}
      {node.role !== "panel" ? (
        <Handle type="target" position={Position.Left} className="fnode-port" isConnectable={false} />
      ) : null}
      {node.role !== "synthesizer" ? (
        <Handle type="source" position={Position.Right} className="fnode-port" isConnectable={false} />
      ) : null}

      <header className="fnode-head">
        <span className="fnode-dot" style={{ background: source.color }} />
        <span className="fnode-role" title={ROLE[node.role].blurb}>
          {ROLE[node.role].label}
        </span>
        <button
          className="fnode-x nodrag"
          aria-label="Remove node"
          onClick={(event) => {
            event.stopPropagation();
            onRemove(node.id);
          }}
        >
          ×
        </button>
      </header>

      <select
        className="fnode-source nodrag nopan"
        aria-label="Source"
        value={node.source}
        onChange={(event) => onChange(node.id, { source: event.target.value as GraphSource })}
      >
        {(Object.keys(SOURCE) as GraphSource[]).map((key) => (
          <option key={key} value={key}>
            {SOURCE[key].label}
          </option>
        ))}
      </select>

      <ModelField node={node} onChange={onChange} />

      <footer className="fnode-foot">
        <select
          className="fnode-effort nodrag nopan"
          aria-label="Thinking budget"
          value={node.effort ?? ""}
          onChange={(event) =>
            onChange(node.id, {
              effort: (event.target.value || undefined) as GraphNode["effort"]
            })
          }
        >
          <option value="">auto effort</option>
          {EFFORTS.map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
        </select>
        {/* Tools are source-aware. Gateway models carry no tools of their own, so
            web is something you attach — a toggle (panel + judge default on, the
            synthesizer off since it writes from their findings). Claude Code and
            Codex are agents that already search the web themselves, so for them web
            is a built-in fact, not a switch. */}
        {node.source === "gateway" ? (
          <button
            className={`fnode-web nodrag nopan ${node.web ? "on" : ""}`}
            aria-label="Toggle web tools"
            aria-pressed={Boolean(node.web)}
            onClick={() => onChange(node.id, { web: !node.web })}
          >
            web
          </button>
        ) : (
          <span
            className="fnode-web builtin nodrag"
            title="Built in — this agent searches the web on its own (read-only)."
          >
            web
          </span>
        )}
      </footer>
    </div>
  );
}

const NODE_TYPES = { fusion: FusionNode };

/* ─── derive React Flow edges from the model ────────────────────────────── */

// Edges are implied by role: every panel feeds the judge (or the synthesizer if
// there's no judge); the judge feeds the synthesizer.
function toFlowEdges(graph: FusionGraph): Edge[] {
  const judge = graph.nodes.find((n) => n.role === "judge");
  const synth = graph.nodes.find((n) => n.role === "synthesizer");
  const panels = graph.nodes.filter((n) => n.role === "panel");
  const edges: Edge[] = [];
  const sink = judge ?? synth;
  if (sink) {
    for (const panel of panels) {
      edges.push(edge(panel.id, sink.id));
    }
  }
  if (judge && synth) {
    edges.push(edge(judge.id, synth.id));
  }
  return edges;
}

function edge(source: string, target: string): Edge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    type: "default",
    animated: false,
    style: { stroke: "rgba(238,229,214,0.22)", strokeWidth: 1.5 }
  };
}

/* ─── studio ────────────────────────────────────────────────────────────── */

type HarnessHealth = {
  id: string;
  status: string;
  reason?: string;
  installed?: boolean;
  enabled?: boolean;
};

type Health = {
  runtime?: {
    gateway?: boolean;
    gateway_reason?: string;
    auth_required?: boolean;
    harnesses?: HarnessHealth[];
  };
};

function sourceReady(source: GraphSource, health: Health | null): boolean {
  if (source === "gateway") return Boolean(health?.runtime?.gateway);
  return health?.runtime?.harnesses?.find((h) => h.id === source)?.status === "ready";
}

function harnessFor(source: GraphSource, health: Health | null): HarnessHealth | undefined {
  if (source === "gateway") return undefined;
  return health?.runtime?.harnesses?.find((h) => h.id === source);
}

function defaultModelFor(source: GraphSource): string {
  if (source === "claude-code") return "sonnet";
  if (source === "codex") return "gpt-5.5";
  return "openai/gpt-5.5";
}

function SourceConfig({
  source,
  ready,
  reason,
  rechecking,
  onRecheck,
  onClose
}: {
  source: GraphSource;
  ready: boolean;
  reason?: string;
  rechecking: boolean;
  onRecheck: () => void;
  onClose: () => void;
}) {
  const setup = SOURCE_SETUP[source];
  const isGateway = source === "gateway";
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [keyInput, setKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  // Where the key comes from (studio store vs environment) and a MASKED preview
  // (last 4) — so a key on file is visible without ever exposing the secret.
  const [credStatus, setCredStatus] = useState<{ source: string; masked: string | null }>({
    source: "none",
    masked: null
  });

  useEffect(() => {
    if (!isGateway) return;
    void fetch("/api/credentials")
      .then((r) => r.json())
      .then((d) =>
        setCredStatus({ source: d?.gateway?.source ?? "none", masked: d?.gateway?.masked ?? null })
      )
      .catch(() => undefined);
  }, [isGateway]);

  // Save the key straight to the local store and re-check — no file editing, no
  // server restart. The key is never read back; the PUT returns only the masked
  // preview + source.
  const saveKey = useCallback(async () => {
    if (!keyInput.trim()) return;
    setSaving(true);
    try {
      const status = await fetch("/api/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gateway_api_key: keyInput.trim() })
      }).then((r) => r.json());
      setKeyInput("");
      setCredStatus({ source: status?.gateway?.source ?? "studio", masked: status?.gateway?.masked ?? null });
      onRecheck();
    } catch {
      // Leave the input intact so the user can retry.
    } finally {
      setSaving(false);
    }
  }, [keyInput, onRecheck]);

  // Remove the studio-stored key, falling back to the environment key (if any).
  const clearKey = useCallback(async () => {
    setSaving(true);
    try {
      const status = await fetch("/api/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gateway_api_key: "" })
      }).then((r) => r.json());
      setCredStatus({ source: status?.gateway?.source ?? "none", masked: status?.gateway?.masked ?? null });
      onRecheck();
    } catch {
      // No-op; the key stays as-is.
    } finally {
      setSaving(false);
    }
  }, [onRecheck]);

  // Move focus into the popover once on open — not on every parent re-render
  // (Recheck flips state and would otherwise keep yanking focus to the × button).
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // Popover expectations: Escape closes, and a click anywhere outside dismisses —
  // except the source chips, which own their own toggle (so a chip click doesn't
  // both close here and reopen there).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (!dialogRef.current?.contains(target) && !target.closest(".src-chip")) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [onClose]);

  return (
    <div className="src-config" role="dialog" aria-label={`${SOURCE[source].label} setup`} ref={dialogRef}>
      <header className="src-config-head">
        <span className="src-led" style={{ background: SOURCE[source].color }} />
        <strong>{SOURCE[source].label}</strong>
        <span className={`src-config-status ${ready ? "ok" : "off"}`}>
          {ready ? "Connected" : "Not connected"}
        </span>
        <button className="src-config-x" aria-label="Close" onClick={onClose} ref={closeRef}>
          ×
        </button>
      </header>
      <p className="src-config-blurb">{setup.blurb}</p>
      {!ready && reason ? <p className="src-config-reason">{reason}</p> : null}

      {isGateway ? (
        <div className="src-config-keyform">
          {credStatus.masked ? (
            <p className="src-config-note src-config-note-row">
              <span>
                Key on file <code className="src-config-mask">{credStatus.masked}</code>
                {credStatus.source === "environment" ? " · from environment" : ""}
              </span>
              {credStatus.source === "studio" ? (
                <button className="src-config-clear" onClick={() => void clearKey()} disabled={saving}>
                  Remove
                </button>
              ) : null}
            </p>
          ) : null}
          <input
            className="src-config-key"
            type="password"
            value={keyInput}
            placeholder={credStatus.masked ? "Paste a new key to replace…" : "Paste your AI Gateway key…"}
            aria-label="AI Gateway API key"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setKeyInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void saveKey();
              }
            }}
          />
          <p className="src-config-note">Stored locally on this machine, never committed. No restart needed.</p>
        </div>
      ) : (
        <ol className="src-config-steps">
          {setup.steps.map((step, index) => (
            <li key={index}>
              <span>{step.label}</span>
              {step.code ? <code>{step.code}</code> : null}
            </li>
          ))}
        </ol>
      )}

      <footer className="src-config-foot">
        <span className="src-config-models">{setup.models}</span>
        <div className="src-config-actions">
          {setup.link ? (
            <a className="src-config-link" href={setup.link.href} target="_blank" rel="noreferrer">
              {setup.link.label} ↗
            </a>
          ) : null}
          {isGateway ? (
            <button
              className="src-config-recheck"
              onClick={() => void saveKey()}
              disabled={saving || !keyInput.trim()}
            >
              {saving ? "Saving…" : "Save key"}
            </button>
          ) : (
            <button className="src-config-recheck" onClick={onRecheck} disabled={rechecking}>
              {rechecking ? "Checking…" : "Recheck"}
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

// Keep the canvas tidy: panels in a vertically-centered left column, the judge
// and synthesizer centered to that block in their own columns. Re-run on every
// add/remove so the graph always reads cleanly left-to-right.
function tidyLayout(nodes: GraphNode[]): GraphNode[] {
  const COL = { panel: 80, judge: 560, synthesizer: 1000 } as const;
  const PANEL_GAP = 200;
  const CENTER_Y = 300;
  const panelCount = Math.max(nodes.filter((n) => n.role === "panel").length, 1);
  const panelTop = CENTER_Y - ((panelCount - 1) * PANEL_GAP) / 2;
  let panelIndex = 0;
  return nodes.map((node) => {
    if (node.role === "panel") {
      const position = { x: COL.panel, y: panelTop + panelIndex * PANEL_GAP };
      panelIndex += 1;
      return { ...node, position };
    }
    const x = node.role === "judge" ? COL.judge : COL.synthesizer;
    return { ...node, position: { x, y: CENTER_Y } };
  });
}

/* ─── presets ───────────────────────────────────────────────────────────────
   One-click councils. Quality mirrors OpenRouter Fusion's default (three frontier
   families); Balanced and Fast trade some depth for cost/speed. Applying a preset
   rewires the whole graph — panels, judge, synthesizer — and tidies the layout. */

type PresetKey = "quality" | "balanced" | "fast";

const PRESETS: Record<
  PresetKey,
  { label: string; blurb: string; panels: string[]; judge: string; synth: string }
> = {
  quality: {
    label: "Quality",
    blurb: "Opus · GPT · Gemini — three frontier families",
    panels: ["anthropic/claude-opus-4.8", "openai/gpt-5.5", "google/gemini-3-pro-preview"],
    judge: "openai/gpt-5.5",
    synth: "anthropic/claude-opus-4.8"
  },
  balanced: {
    label: "Balanced",
    blurb: "Strong panel, lighter cost",
    panels: ["anthropic/claude-sonnet-4.6", "openai/gpt-5.5", "deepseek/deepseek-v4-pro"],
    judge: "openai/gpt-5.5",
    synth: "anthropic/claude-sonnet-4.6"
  },
  fast: {
    label: "Fast",
    blurb: "Two quick models, lean budget",
    panels: ["google/gemini-3.5-flash", "deepseek/deepseek-v4-flash"],
    judge: "google/gemini-3.5-flash",
    synth: "anthropic/claude-sonnet-4.6"
  }
};

// Build a fresh, tidied node set for a preset. All Gateway; panel + judge get web
// (as in Fusion), the synthesizer writes from their findings so its web is off.
function presetNodes(preset: PresetKey): GraphNode[] {
  const p = PRESETS[preset];
  const nodes: GraphNode[] = [
    ...p.panels.map(
      (model, i): GraphNode => ({
        id: `panel-${i + 1}`,
        role: "panel",
        source: "gateway",
        model,
        web: true,
        position: { x: 0, y: 0 }
      })
    ),
    { id: "judge-1", role: "judge", source: "gateway", model: p.judge, web: true, position: { x: 0, y: 0 } },
    {
      id: "synth-1",
      role: "synthesizer",
      source: "gateway",
      model: p.synth,
      web: false,
      effort: "high",
      position: { x: 0, y: 0 }
    }
  ];
  return tidyLayout(nodes);
}

function elapsedLabel(node: ActivityNode, now: number): string {
  if (!node.startedAt) return "";
  const end = node.finishedAt ?? now;
  return `${Math.max(0, (end - node.startedAt) / 1000).toFixed(1)}s`;
}

function toolLabel(tool: ActivityTool): string {
  const args = tool.args as Record<string, unknown> | undefined;
  // Different providers name the search payload differently (query, objective,
  // search_queries[], or a url to fetch) — surface whichever reads best.
  const pick = (value: unknown): string | undefined => {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const first = value.find((v) => typeof v === "string" && v.trim());
      return typeof first === "string" ? first : undefined;
    }
    return undefined;
  };
  const detail = args
    ? pick(args.query) ?? pick(args.objective) ?? pick(args.search_queries) ?? pick(args.url)
    : undefined;
  const name = tool.tool.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
  return detail ? `${name} · ${detail}` : name;
}

// The tail of a node's output, for the one-line "currently typing" preview shown
// on a running row before you expand it.
function streamTail(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 88 ? `…${flat.slice(-88)}` : flat;
}

function previewValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const STATUS_GLYPH: Record<NodeStatus, string> = {
  idle: "○",
  running: "",
  done: "✓",
  failed: "✕"
};

// The run drawer. Reads the folded activity list and renders the council working,
// grouped Panel → Judge → Synthesis, each row expandable to its tool calls and
// (for panels) its answer. Detail styling follows t3code's step list.
function RunActivityLog({
  nodes,
  running,
  onClose
}: {
  nodes: ActivityNode[];
  running: boolean;
  onClose?: () => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());

  // A 10fps clock, but only while a run is live, so elapsed timers advance
  // without re-rendering the studio when nothing is happening.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [running]);

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const groups = (
    [
      { role: "panel", title: "Panel" },
      { role: "judge", title: "Judge" },
      { role: "synthesizer", title: "Synthesis" }
    ] as const
  )
    .map((g) => ({ ...g, items: nodes.filter((n) => n.role === g.role) }))
    .filter((g) => g.items.length > 0);

  return (
    <section className="activity" aria-label="Run activity">
      <header className="activity-head">
        <span className={`activity-title ${running ? "live" : ""}`}>
          {running ? "Running" : "Run detail"}
        </span>
        {onClose ? (
          <button className="activity-x nodrag" aria-label="Close activity log" onClick={onClose}>
            ×
          </button>
        ) : null}
      </header>
      <div className="activity-body">
        {groups.map((group) => (
          <section key={group.role} className="activity-group">
            <div className="activity-phase">{group.title}</div>
            {group.items.map((node) => {
              const open = expanded.has(node.key);
              const canExpand = node.tools.length > 0 || Boolean(node.text) || Boolean(node.error);
              return (
                <div key={node.key} className={`arow status-${node.status}`}>
                  <button
                    className="arow-head nodrag"
                    onClick={() => canExpand && toggle(node.key)}
                    aria-expanded={canExpand ? open : undefined}
                    data-expandable={canExpand}
                  >
                    <span className={`arow-icon status-${node.status}`} aria-hidden="true">
                      {STATUS_GLYPH[node.status]}
                    </span>
                    <span className="arow-label">{node.label}</span>
                    <span className="arow-model" title={node.model}>
                      {node.model}
                    </span>
                    <span className="arow-meta tabular">
                      {node.tools.length > 0
                        ? `${node.tools.length} tool${node.tools.length > 1 ? "s" : ""} · `
                        : ""}
                      {node.tokens != null ? `${node.tokens.toLocaleString()} tok · ` : ""}
                      {elapsedLabel(node, now)}
                    </span>
                    {canExpand ? (
                      <span className={`arow-chev ${open ? "open" : ""}`} aria-hidden="true">
                        ⌄
                      </span>
                    ) : null}
                  </button>
                  {node.status === "running" && node.text && !open ? (
                    <div className="arow-stream">
                      {streamTail(node.text)}
                      <span className="arow-stream-caret" aria-hidden="true" />
                    </div>
                  ) : null}
                  {node.status === "failed" && node.error && !open ? (
                    <div className="arow-errline">{node.error}</div>
                  ) : null}
                  {open && canExpand ? (
                    <div className="arow-detail">
                      {node.error ? <pre className="arow-errbox">{node.error}</pre> : null}
                      {node.tools.map((tool) => (
                        <div key={tool.callId} className={`atool status-${tool.status}`}>
                          <span className="atool-name">{toolLabel(tool)}</span>
                          {tool.result != null ? (
                            <pre className="atool-result">{previewValue(tool.result)}</pre>
                          ) : null}
                        </div>
                      ))}
                      {node.text ? <pre className="arow-text">{node.text}</pre> : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </section>
  );
}

// Council-level settings — the Fusion knobs that aren't per-node: the model id
// external clients call, the shared tool budget, sampling temperature, strict
// mode, quick presets, and a reset. A popover anchored to the bar, dismissed on
// Escape or an outside click (same contract as the source config).
function CouncilSettings({
  graph,
  onPatch,
  onApplyPreset,
  onReset,
  onClose
}: {
  graph: FusionGraph;
  onPatch: (patch: Partial<FusionGraph>) => void;
  onApplyPreset: (preset: PresetKey) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (!dialogRef.current?.contains(target) && !target.closest(".studio-gear")) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [onClose]);

  const tempActive = graph.temperature != null;

  return (
    <div className="council" role="dialog" aria-label="Council settings" ref={dialogRef}>
      <header className="council-head">
        <strong>Council settings</strong>
        <button className="src-config-x" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>

      <div className="council-presets">
        {(Object.keys(PRESETS) as PresetKey[]).map((key) => (
          <button key={key} className="council-preset" title={PRESETS[key].blurb} onClick={() => onApplyPreset(key)}>
            {PRESETS[key].label}
          </button>
        ))}
      </div>

      <label className="council-field">
        <span>Model id <em>clients call this</em></span>
        <input
          className="council-input"
          value={graph.name}
          spellCheck={false}
          aria-label="Council model id"
          onChange={(event) => onPatch({ name: event.target.value.trim() || "openfusion" })}
        />
      </label>

      <label className="council-field">
        <span>Max tool calls <em>per node, web/local</em></span>
        <select
          className="council-input"
          value={graph.max_tool_calls}
          aria-label="Max tool calls"
          onChange={(event) => onPatch({ max_tool_calls: Number(event.target.value) })}
        >
          {Array.from({ length: 16 }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>

      <div className="council-field">
        <span>
          Temperature <em>panel + synthesizer</em>
        </span>
        <div className="council-temp">
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={graph.temperature ?? 0.2}
            aria-label="Temperature"
            onChange={(event) => onPatch({ temperature: Number(event.target.value) })}
          />
          <span className="council-temp-value tabular">{tempActive ? graph.temperature?.toFixed(2) : "0.20"}</span>
          <button
            className="council-auto"
            disabled={!tempActive}
            onClick={() => onPatch({ temperature: undefined })}
            title="Use the default temperature"
          >
            auto
          </button>
        </div>
      </div>

      <button
        className={`council-toggle ${graph.strict ? "on" : ""}`}
        role="switch"
        aria-checked={Boolean(graph.strict)}
        onClick={() => onPatch({ strict: !graph.strict })}
      >
        <span className="council-toggle-dot" />
        <span>
          Strict Fusion mode
          <em>no local tools · forced pipeline · synth answers only from the analysis</em>
        </span>
      </button>

      <footer className="council-foot">
        <button className="council-reset" onClick={onReset}>
          Reset to default council
        </button>
      </footer>
    </div>
  );
}

// One labelled, copyable value (Base URL / key / model).
function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="ep-field">
      <span className="ep-label">{label}</span>
      <code className="ep-value" title={value}>
        {value}
      </code>
      <button className="ep-copy" aria-label={`Copy ${label}`} onClick={copy}>
        {copied ? "✓" : "Copy"}
      </button>
    </div>
  );
}

// A copyable multi-line snippet (curl, an aider command, …).
function CopyBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="ep-block">
      <pre>{code}</pre>
      <button className="ep-block-copy" aria-label="Copy snippet" onClick={copy}>
        {copied ? "✓" : "Copy"}
      </button>
    </div>
  );
}

// The "use it from anywhere" panel: OpenFusion speaks the OpenAI API, so this is
// the in-app quick reference — base URL, key, model, and copy-paste configs for
// the common clients. The base URL tracks the real host; the model tracks the
// council's name (rename it in settings and this updates).
function EndpointPanel({
  origin,
  modelId,
  authRequired,
  onClose
}: {
  origin: string;
  modelId: string;
  authRequired: boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (!dialogRef.current?.contains(target) && !target.closest(".endpoint-bar")) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [onClose]);

  const base = `${origin}/v1`;
  const key = "local-fusion";
  const curl = `curl ${base}/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${modelId}","messages":[{"role":"user","content":"Hello"}]}'`;
  const aider = `aider --openai-api-base ${base} \\
  --openai-api-key ${key} --model ${modelId}`;

  return (
    <div className="endpoint" role="dialog" aria-label="OpenAI-compatible endpoint" ref={dialogRef}>
      <header className="endpoint-head">
        <span className="endpoint-led" />
        <strong>OpenAI-compatible endpoint</strong>
        <button className="src-config-x" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>
      <p className="endpoint-blurb">
        Point any OpenAI client here — your active council runs for every call, and the answer
        token-streams back.
      </p>

      <div className="endpoint-fields">
        <CopyField label="Base URL" value={base} />
        <CopyField label="API key" value={key} />
        <CopyField label="Model" value={modelId} />
      </div>
      <p className="endpoint-note">
        {authRequired
          ? "This server requires a key (FUSION_API_KEYS is set) — use one of those values."
          : "Any non-empty key works. Set FUSION_API_KEYS to require specific keys."}
      </p>

      <div className="endpoint-snippet">
        <span className="endpoint-snippet-label">curl</span>
        <CopyBlock code={curl} />
      </div>

      <div className="endpoint-tools">
        <div className="endpoint-tool">
          <strong>Cursor</strong>
          <span>Settings → Models → OpenAI API → Override Base URL → paste the Base URL above.</span>
        </div>
        <div className="endpoint-tool">
          <strong>aider</strong>
          <CopyBlock code={aider} />
        </div>
        <div className="endpoint-tool">
          <strong>Continue · OpenCode · OpenAI SDK</strong>
          <span>
            Same three values — more clients in <code className="endpoint-inline">docs/SETUP.md</code>.
          </span>
        </div>
      </div>
    </div>
  );
}

function Studio() {
  const [graph, setGraph] = useState<FusionGraph | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, NodeStatus>>({});
  const [health, setHealth] = useState<Health | null>(null);
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [activity, setActivity] = useState<ActivityNode[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [showEndpoint, setShowEndpoint] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);
  // The real origin (host:port) for the endpoint card, read after mount so the
  // displayed base URL matches wherever the studio is actually served.
  const [origin, setOrigin] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Aborts the in-flight run when the user hits Stop.
  const abortRef = useRef<AbortController | null>(null);
  const [, setSaved] = useState(true);
  const [configSource, setConfigSource] = useState<GraphSource | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  // Synchronous re-entrancy guard: `running` state is async, so two Enter presses
  // in one frame could both pass the guard. A ref flips immediately.
  const runningRef = useRef(false);
  // Bumped on add/remove so the sync effect snaps every node to its tidy position
  // that pass; between bumps it preserves manual drags.
  const [relayoutTick, setRelayoutTick] = useState(0);
  const relayoutAppliedRef = useRef(0);

  const loadHealth = useCallback(async () => {
    setRechecking(true);
    try {
      // Ask for the deep probe so "Connected" reflects a real, runnable gateway
      // (catches a spent-out key), not just that a key string exists.
      const data = await fetch("/api/health?probe=deep").then((r) => r.json());
      setHealth(data);
    } catch {
      // leave the last known health in place
    } finally {
      setRechecking(false);
    }
  }, []);

  const loadGraph = useCallback(async () => {
    setLoadError(false);
    try {
      const data = await fetch("/api/graph").then((r) => r.json());
      if (!data?.graph) throw new Error("Malformed graph response.");
      // Open tidy: a previously-saved messy arrangement self-heals into clean
      // columns. Bump the relayout tick so the sync effect uses these positions.
      setRelayoutTick((tick) => tick + 1);
      setGraph({ ...data.graph, nodes: tidyLayout(data.graph.nodes) });
    } catch {
      // A failed/unreachable endpoint must not look like a slow load — surface a
      // retry instead of spinning on "Composing your council…" forever.
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void loadGraph();
    void loadHealth();
    setOrigin(window.location.origin);
  }, [loadGraph, loadHealth]);

  const persist = useCallback((next: FusionGraph) => {
    setSaved(false);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void fetch("/api/graph", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next)
      })
        .then(() => setSaved(true))
        .catch(() => undefined);
    }, 500);
  }, []);

  const mutate = useCallback(
    (updater: (graph: FusionGraph) => FusionGraph) => {
      setGraph((current) => {
        if (!current) return current;
        const next = updater(current);
        persist(next);
        return next;
      });
    },
    [persist]
  );

  const onChange = useCallback(
    (id: string, patch: Partial<GraphNode>) =>
      mutate((g) => ({
        ...g,
        nodes: g.nodes.map((n) =>
          n.id === id
            ? { ...n, ...patch, model: patch.source ? defaultModelFor(patch.source) : (patch.model ?? n.model) }
            : n
        )
      })),
    [mutate]
  );

  const onRemove = useCallback(
    (id: string) => {
      setRelayoutTick((tick) => tick + 1);
      mutate((g) => ({ ...g, nodes: tidyLayout(g.nodes.filter((n) => n.id !== id)) }));
    },
    [mutate]
  );

  const addNode = useCallback(
    (role: GraphRole) => {
      setRelayoutTick((tick) => tick + 1);
      mutate((g) => {
        const next: GraphNode = {
          id: `${role}-${crypto.randomUUID().slice(0, 8)}`,
          role,
          source: "gateway",
          model: defaultModelFor("gateway"),
          // Panel and judge get web tools by default (as in OpenRouter Fusion);
          // the synthesizer writes from their findings, so it defaults off.
          web: role !== "synthesizer",
          position: { x: 0, y: 0 }
        };
        // tidyLayout assigns every node its clean position, the new one included.
        return { ...g, nodes: tidyLayout([...g.nodes, next]) };
      });
    },
    [mutate]
  );

  // Patch council-level fields (name, tool budget, temperature, strict).
  const patchGraph = useCallback(
    (patch: Partial<FusionGraph>) => mutate((g) => ({ ...g, ...patch })),
    [mutate]
  );

  // Swap the whole council to a preset (or back to default), tidying the layout.
  const applyPreset = useCallback(
    (preset: PresetKey) => {
      setRelayoutTick((tick) => tick + 1);
      setStatuses({});
      mutate((g) => ({ ...g, nodes: presetNodes(preset) }));
    },
    [mutate]
  );

  const resetCouncil = useCallback(() => {
    setRelayoutTick((tick) => tick + 1);
    setStatuses({});
    mutate((g) => ({
      ...g,
      name: "openfusion",
      max_tool_calls: 8,
      temperature: undefined,
      strict: false,
      nodes: presetNodes("quality")
    }));
  }, [mutate]);

  // React Flow owns node measurement, dragging, and selection, so the canvas is
  // its own state — we mirror the graph into it rather than feeding a freshly
  // derived array every render (which left nodes unmeasured and invisible).
  const [rfNodes, setRfNodes, onNodesChangeBase] = useNodesState<Node<StudioNodeData>>([]);
  const { fitView } = useReactFlow();
  const fitted = useRef(false);

  useEffect(() => {
    if (!graph) return;
    // On an add/remove pass, snap to the graph's (tidy) positions; otherwise keep
    // whatever the user dragged the nodes to.
    const forceLayout = relayoutAppliedRef.current !== relayoutTick;
    relayoutAppliedRef.current = relayoutTick;
    setRfNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return graph.nodes.map((node) => {
        const existing = prevById.get(node.id);
        return {
          id: node.id,
          type: "fusion",
          position: forceLayout || !existing ? node.position : existing.position,
          ...(existing?.measured ? { measured: existing.measured } : {}),
          selected: existing?.selected,
          data: { node, status: statuses[node.id] ?? "idle", onChange, onRemove }
        } as Node<StudioNodeData>;
      });
    });
  }, [graph, statuses, onChange, onRemove, setRfNodes, relayoutTick]);

  // Frame the council once the first nodes arrive. The graph loads async, so the
  // `fitView` prop would fit an empty canvas and strand every node off-screen.
  useEffect(() => {
    if (fitted.current || rfNodes.length === 0) return;
    fitted.current = true;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const handle = requestAnimationFrame(() =>
      void fitView({ padding: 0.25, duration: reduceMotion ? 0 : 300 })
    );
    return () => cancelAnimationFrame(handle);
  }, [rfNodes.length, fitView]);

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<StudioNodeData>>[]) => {
      onNodesChangeBase(changes);
      // Persist a node's new position to the graph only when its drag finishes.
      if (!changes.some((c) => c.type === "position" && c.dragging === false)) return;
      const moved = new Map<string, { x: number; y: number }>();
      for (const change of changes) {
        if (change.type === "position" && change.position) moved.set(change.id, change.position);
      }
      if (moved.size === 0) return;
      setGraph((current) => {
        if (!current) return current;
        const next = {
          ...current,
          nodes: current.nodes.map((n) => (moved.has(n.id) ? { ...n, position: moved.get(n.id)! } : n))
        };
        persist(next);
        return next;
      });
    },
    [onNodesChangeBase, persist]
  );

  const flowEdges = useMemo(() => (graph ? toFlowEdges(graph) : []), [graph]);
  const validation = useMemo(
    () => (graph ? validateGraph(graph) : { ok: false, errors: [] }),
    [graph]
  );

  const run = useCallback(async () => {
    if (!graph || !prompt.trim() || running || runningRef.current || !validation.ok) return;

    const userContent = prompt;

    // Pre-flight: a node can only run if its source is connected. Surface the
    // unreachable sources as a failed turn and point at the fix instead of firing a
    // request that can only error out. Skip until health is known so we never block
    // a genuinely-connected source on a stale null.
    const unreachable = health ? graph.nodes.filter((n) => !sourceReady(n.source, health)) : [];
    if (unreachable.length > 0) {
      setStatuses(Object.fromEntries(unreachable.map((n) => [n.id, "failed" as NodeStatus])));
      const labels = [...new Set(unreachable.map((n) => SOURCE[n.source].label))];
      setTurns((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "user", content: userContent },
        {
          id: crypto.randomUUID(),
          role: "assistant",
          error: true,
          content:
            `Connect ${labels.join(" and ")} first — click the source chip up top. ` +
            `${unreachable.length} node${unreachable.length > 1 ? "s" : ""} can't reach ${unreachable.length > 1 ? "their source" : "its source"}.`
        }
      ]);
      setPrompt("");
      return;
    }

    // The conversation is the only state carried across turns. Send the prior
    // transcript so every panelist, the judge, and the synthesizer see it as
    // context — while the council itself re-runs fresh each message (statuses reset
    // below). Drop any failed exchange whole — both the error turn AND the user turn
    // that preceded it — so a retry never re-sends the failed prompt or leaves two
    // user messages in a row. Only the synthesized final is kept; raw panel
    // internals are never fed forward.
    const history: { role: "user" | "assistant"; content: string }[] = [];
    for (let i = 0; i < turns.length; i += 1) {
      const turn = turns[i];
      if (turn.error) continue;
      if (turn.role === "user" && turns[i + 1]?.role === "assistant" && turns[i + 1]?.error) {
        continue;
      }
      history.push({ role: turn.role, content: turn.content });
    }
    const assistantId = crypto.randomUUID();
    setTurns((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", content: userContent },
      { id: assistantId, role: "assistant", content: "" }
    ]);
    setPrompt("");
    setRunning(true);
    runningRef.current = true;
    setStatuses({});
    setActivity([]);

    const patchAssistant = (patch: Partial<ChatTurn>) =>
      setTurns((prev) => prev.map((turn) => (turn.id === assistantId ? { ...turn, ...patch } : turn)));

    // Map the streamed run events back onto canvas nodes: panel events carry an
    // index into the (ordered) panel nodes; judge/synth map to their singletons.
    const panelIds = graph.nodes.filter((n) => n.role === "panel").map((n) => n.id);
    const judgeId = graph.nodes.find((n) => n.role === "judge")?.id;
    const synthId = graph.nodes.find((n) => n.role === "synthesizer")?.id;
    const setStatus = (id: string | undefined, status: NodeStatus) => {
      if (!id) return;
      setStatuses((current) => ({ ...current, [id]: status }));
    };
    const applyEvent = (event: FusionRunEvent) => {
      // Fold every event into the activity drawer; the switch below only mirrors
      // node lifecycle onto the canvas highlight.
      setActivity((prev) => reduceActivity(prev, event));
      const index = event.data?.index as number | undefined;
      switch (event.type) {
        case "panel.started":
          if (index != null) setStatus(panelIds[index], "running");
          break;
        case "panel.finished":
          if (index != null) setStatus(panelIds[index], "done");
          break;
        case "panel.failed":
          if (index != null) setStatus(panelIds[index], "failed");
          break;
        case "judge.started":
          setStatus(judgeId, "running");
          break;
        case "judge.finished":
          setStatus(judgeId, "done");
          break;
        case "judge.failed":
          setStatus(judgeId, "failed");
          break;
        case "synthesis.started":
          setStatus(synthId, "running");
          break;
        case "synthesis.finished":
          setStatus(synthId, "done");
          break;
        case "synthesis.failed":
          setStatus(synthId, "failed");
          break;
      }
    };

    const controller = new AbortController();
    abortRef.current = controller;
    // Hoisted so a Stop (caught below) can keep whatever already streamed.
    let finalText = "";

    try {
      const response = await fetch("/v1/chat/completions", {
        method: "POST",
        // Placeholder bearer for same-origin calls from the studio — not a secret.
        // Real auth only kicks in when the operator sets FUSION_API_KEYS.
        headers: { "content-type": "application/json", authorization: "Bearer local-fusion" },
        signal: controller.signal,
        body: JSON.stringify({
          model: graph.name,
          stream: true,
          messages: [...history, { role: "user", content: userContent }]
        })
      });
      if (!response.body) throw new Error("No response stream.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      type FusionMeta = { cost_usd?: number; latency_ms?: { end_to_end?: number } };
      let fusionMeta: FusionMeta | null = null;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let chunk: Record<string, unknown>;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }
          if (chunk.fusion_event) applyEvent(chunk.fusion_event as FusionRunEvent);
          const delta = (chunk.choices as { delta?: { content?: string } }[] | undefined)?.[0]?.delta;
          if (typeof delta?.content === "string") {
            finalText += delta.content;
            patchAssistant({ content: finalText });
          }
          if (chunk.fusion) fusionMeta = chunk.fusion as FusionMeta;
        }
      }

      patchAssistant({
        content: finalText.trim() || "(no response)",
        cost: fusionMeta?.cost_usd,
        latency: fusionMeta?.latency_ms?.end_to_end
      });
    } catch (error) {
      const stopped = error instanceof DOMException && error.name === "AbortError";
      // A user Stop isn't a failure: keep whatever streamed, mark it stopped, and
      // clear the in-flight node highlights rather than flagging them red.
      patchAssistant(
        stopped
          ? { content: finalText.trim() || "Stopped." }
          : { content: error instanceof Error ? error.message : String(error), error: true }
      );
      setStatuses((current) => {
        const next = { ...current };
        for (const id of Object.keys(next)) {
          if (next[id] === "running") next[id] = stopped ? "idle" : "failed";
        }
        return next;
      });
    } finally {
      abortRef.current = null;
      setRunning(false);
      runningRef.current = false;
    }
  }, [graph, prompt, running, validation.ok, health, turns]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  // Follow the stream, but don't yank the view down if the user scrolled up to
  // read an earlier turn.
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [turns]);

  // Grow the composer with what's typed (up to a cap, then it scrolls), so the
  // whole prompt stays visible — and snap back to one line once it's sent.
  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [prompt]);

  const sources = useMemo(
    () =>
      (["gateway", "claude-code", "codex"] as GraphSource[]).map((key) => ({
        key,
        ready: sourceReady(key, health)
      })),
    [health]
  );

  if (!graph) {
    if (loadError) {
      return (
        <div className="studio studio-loading">
          <p>Couldn’t reach the OpenFusion server.</p>
          <button className="studio-retry" onClick={() => void loadGraph()}>
            Try again
          </button>
        </div>
      );
    }
    return <div className="studio studio-loading">Composing your council…</div>;
  }

  return (
    <div className="studio">
      <header className="studio-bar">
        <div className="studio-brand">
          <BrandMark />
          <strong>OpenFusion</strong>
        </div>
        <div className="studio-sources">
          {sources.map((s) => (
            <button
              key={s.key}
              type="button"
              className={`src-chip ${s.ready ? "ready" : ""} ${configSource === s.key ? "open" : ""}`}
              title={s.ready ? `${SOURCE[s.key].label} — connected` : `Connect ${SOURCE[s.key].label}`}
              onClick={() => setConfigSource((current) => (current === s.key ? null : s.key))}
            >
              <span className="src-led" />
              {SOURCE[s.key].label}
              {s.ready ? null : <span className="src-state">connect</span>}
            </button>
          ))}
        </div>
        {configSource ? (
          <SourceConfig
            source={configSource}
            ready={sourceReady(configSource, health)}
            reason={
              configSource === "gateway"
                ? health?.runtime?.gateway_reason
                : harnessFor(configSource, health)?.reason
            }
            rechecking={rechecking}
            onRecheck={() => void loadHealth()}
            onClose={() => setConfigSource(null)}
          />
        ) : null}
        {origin ? (
          <div className={`endpoint-bar ${showEndpoint ? "open" : ""}`}>
            <button
              className="endpoint-open"
              title="OpenAI-compatible endpoint — click for setup"
              onClick={() => setShowEndpoint((open) => !open)}
            >
              <span className="endpoint-led" />
              <span className="endpoint-scheme">{origin.startsWith("https") ? "https" : "http"}://</span>
              <code className="endpoint-url">{origin.replace(/^https?:\/\//, "")}/v1</code>
            </button>
            <button
              className="endpoint-bar-copy"
              title="Copy the base URL"
              onClick={() => {
                void navigator.clipboard?.writeText(`${origin}/v1`);
                setUrlCopied(true);
                setTimeout(() => setUrlCopied(false), 1200);
              }}
            >
              {urlCopied ? "✓ Copied" : "Copy"}
            </button>
          </div>
        ) : null}
        {showEndpoint ? (
          <EndpointPanel
            origin={origin}
            modelId={graph.name}
            authRequired={Boolean(health?.runtime?.auth_required)}
            onClose={() => setShowEndpoint(false)}
          />
        ) : null}
        <div className="studio-add">
          {/* A council has 1–8 panels, at most one judge, exactly one synthesizer —
              so only show an add button when adding one is actually valid. */}
          <button onClick={() => addNode("panel")} disabled={graph.nodes.filter((n) => n.role === "panel").length >= 8}>
            + Panel
          </button>
          {graph.nodes.some((n) => n.role === "judge") ? null : (
            <button onClick={() => addNode("judge")}>+ Judge</button>
          )}
          {graph.nodes.some((n) => n.role === "synthesizer") ? null : (
            <button onClick={() => addNode("synthesizer")}>+ Synthesizer</button>
          )}
          <button
            className={`studio-gear ${showSettings ? "open" : ""}`}
            aria-label="Council settings"
            aria-pressed={showSettings}
            title="Council settings — presets, tool budget, temperature"
            onClick={() => setShowSettings((open) => !open)}
          >
            ⚙
          </button>
        </div>
        {showSettings ? (
          <CouncilSettings
            graph={graph}
            onPatch={patchGraph}
            onApplyPreset={applyPreset}
            onReset={resetCouncil}
            onClose={() => setShowSettings(false)}
          />
        ) : null}
      </header>

      <div className="studio-canvas">
        <ReactFlow
          nodes={rfNodes}
          edges={flowEdges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          colorMode="dark"
          proOptions={{ hideAttribution: true }}
          defaultEdgeOptions={{ type: "default" }}
          minZoom={0.3}
          maxZoom={1.6}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="rgba(238,229,214,0.10)" />
          <Controls showInteractive={false} position="bottom-left" />
        </ReactFlow>
      </div>

      <aside className="studio-side">
        <div className="side-head">
          <span className="side-title">Chat</span>
          {turns.length > 0 || activity.length > 0 ? (
            <button
              className="side-new"
              title="Start a new thread"
              onClick={() => {
                setTurns([]);
                setActivity([]);
              }}
            >
              New thread
            </button>
          ) : null}
        </div>

        <div className="side-scroll" ref={transcriptRef} role="log" aria-live="polite" aria-atomic="false">
          {turns.length === 0 ? (
            <div className="side-empty">
              <p>Send a prompt to run your council.</p>
              <p className="side-empty-sub">
                Panels answer in parallel, the judge compares them, the synthesizer writes the final
                answer — you’ll watch each model work right here.
              </p>
            </div>
          ) : null}

          {turns.map((turn, index) => {
            const isLast = index === turns.length - 1;
            const streaming = running && turn.role === "assistant" && isLast;
            return (
              <div key={turn.id} className={`turn turn-${turn.role}${turn.error ? " turn-error" : ""}`}>
                <div className="turn-head">
                  <span className="turn-role">{turn.role === "user" ? "You" : "OpenFusion"}</span>
                  {turn.role === "assistant" && turn.content.trim() && !turn.error ? (
                    <button
                      className="turn-copy nodrag"
                      aria-label={copiedId === turn.id ? "Copied" : "Copy answer"}
                      onClick={() => {
                        void navigator.clipboard?.writeText(turn.content);
                        setCopiedId(turn.id);
                        setTimeout(() => setCopiedId((id) => (id === turn.id ? null : id)), 1200);
                      }}
                    >
                      {copiedId === turn.id ? "Copied" : "Copy"}
                    </button>
                  ) : null}
                </div>
                {/* The live council activity sits with the assistant turn it produced —
                    inline, the way Cursor shows an agent's steps above its answer. */}
                {turn.role === "assistant" && isLast && activity.length > 0 ? (
                  <RunActivityLog nodes={activity} running={running} />
                ) : null}
                {turn.content.trim() || turn.role === "user" ? (
                  <div className="turn-body">
                    {turn.content}
                    {streaming ? <span className="result-caret" aria-hidden="true" /> : null}
                  </div>
                ) : null}
                {turn.role === "assistant" && (turn.cost != null || turn.latency != null) ? (
                  <div className="turn-meta tabular">
                    {turn.latency != null ? `${(turn.latency / 1000).toFixed(1)}s` : "—"} ·{" "}
                    {turn.cost != null ? `$${turn.cost.toFixed(4)}` : "—"}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className={`side-input ${validation.ok ? "" : "invalid"}`}>
          {validation.ok ? null : (
            <span className="run-warn" title={validation.errors.join(" ")}>
              {validation.errors[0]}
            </span>
          )}
          <div className="composer">
            <textarea
              className="run-prompt"
              ref={promptRef}
              value={prompt}
              rows={1}
              placeholder={validation.ok ? "Send a prompt through your council…" : "Finish wiring the council to run…"}
              spellCheck={false}
              disabled={!validation.ok}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter for a newline — like a chat composer.
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void run();
                }
              }}
            />
            <div className="composer-actions">
              <span className="composer-hint">↵ to run · ⇧↵ for a new line</span>
              {running ? (
                <button className="run-go run-stop" onClick={stop} title="Stop the run">
                  Stop
                </button>
              ) : (
                <button
                  className="run-go"
                  disabled={!prompt.trim() || !validation.ok}
                  onClick={() => void run()}
                >
                  Run
                </button>
              )}
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

export function FusionStudio() {
  return (
    <ReactFlowProvider>
      <Studio />
    </ReactFlowProvider>
  );
}
