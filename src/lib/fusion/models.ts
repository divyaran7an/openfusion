import type { FusionMode } from "./schemas";

export type FusionPreset = {
  mode: FusionMode;
  alias: string;
  shortAlias: string;
  compatibleAliases?: string[];
  description: string;
  panelModels: string[];
  judgeModel: string;
  outerModel: string;
  webEnabled: boolean;
  localToolsEnabled: boolean;
  maxToolCalls: number;
};

export type ClientModelAlias = {
  alias: string;
  mode: FusionMode;
};

// The first three are the default quality panel (see fusion3Models below).
const fusion8Models = [
  "anthropic/claude-opus-4.8",
  "openai/gpt-5.5",
  "google/gemini-3.1-pro-preview",
  "anthropic/claude-fable-5",
  "anthropic/claude-sonnet-5",
  "deepseek/deepseek-v4-pro",
  "moonshotai/kimi-k2.6",
  "google/gemini-3.5-flash"
];

const defaultFastModel = process.env.FUSION_FAST_MODEL ?? "google/gemini-3.5-flash";
const defaultJudgeModel = process.env.FUSION_JUDGE_MODEL ?? "openai/gpt-5.5";
const defaultOuterModel =
  process.env.FUSION_OUTER_MODEL ?? "anthropic/claude-opus-4.8";
const fusion3Models = fusion8Models.slice(0, 3);

const BUILT_IN_ALIAS_TO_MODE: Record<string, FusionMode> = {
  "fusion/fast": "fast",
  fast: "fast",
  "fusion/research": "research",
  research: "research",
  "openrouter/fusion": "openfusion",
  "fusion/fusion": "openfusion",
  fusion: "openfusion",
  openfusion: "openfusion",
  "fusion/fusion-3": "fusion-3",
  "fusion-3": "fusion-3",
  "fusion/fusion-8": "fusion-8",
  "fusion-8": "fusion-8"
};

const PUBLIC_BUILT_IN_ALIASES = [
  "openfusion",
  "fusion",
  "openrouter/fusion"
];

const LEGACY_ALIAS_PREFIXES = ["fusion/fusion/"];

function normalizeLegacyAlias(model: string): string {
  for (const prefix of LEGACY_ALIAS_PREFIXES) {
    if (model.startsWith(prefix)) {
      return `fusion/${model.slice(prefix.length)}`;
    }
  }
  return model;
}

function parseModeTarget(target: string): FusionMode | undefined {
  return BUILT_IN_ALIAS_TO_MODE[normalizeLegacyAlias(target.trim())];
}

export function clientModelAliases(): ClientModelAlias[] {
  return (process.env.FUSION_MODEL_ALIASES ?? "")
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const separator = entry.includes("=") ? "=" : ":";
      const [rawAlias, rawMode, ...rest] = entry.split(separator);
      const alias = rawAlias?.trim();
      const mode = parseModeTarget(rawMode ?? "");

      if (!alias || rest.length || !mode || BUILT_IN_ALIAS_TO_MODE[alias]) {
        return [];
      }

      return [{ alias, mode }];
    });
}

export function aliasesForMode(mode: FusionMode) {
  const preset = FUSION_PRESETS[mode];
  return [
    preset.alias,
    preset.shortAlias,
    ...(preset.compatibleAliases ?? []),
    ...clientModelAliases()
      .filter((entry) => entry.mode === mode)
      .map((entry) => entry.alias)
  ];
}

export function publicModelAliases() {
  return Array.from(new Set([
    ...PUBLIC_BUILT_IN_ALIASES,
    ...clientModelAliases().map((entry) => entry.alias)
  ]));
}

export const FUSION_PRESETS: Record<FusionMode, FusionPreset> = {
  openfusion: {
    mode: "openfusion",
    alias: "openfusion",
    shortAlias: "fusion",
    compatibleAliases: [
      "openrouter/fusion",
      "fusion/fusion"
    ],
    description: "The active OpenFusion graph.",
    panelModels: fusion3Models,
    judgeModel: defaultJudgeModel,
    outerModel: defaultOuterModel,
    webEnabled: true,
    localToolsEnabled: true,
    maxToolCalls: 8
  },
  fast: {
    mode: "fast",
    alias: "fusion/fast",
    shortAlias: "fast",
    compatibleAliases: ["fusion/fast"],
    description: "Single fast model with web and local tools.",
    panelModels: [defaultFastModel],
    judgeModel: defaultJudgeModel,
    outerModel: defaultOuterModel,
    webEnabled: true,
    localToolsEnabled: true,
    maxToolCalls: 4
  },
  research: {
    mode: "research",
    alias: "fusion/research",
    shortAlias: "research",
    compatibleAliases: ["fusion/research"],
    description: "Single research model with expanded tool budget.",
    panelModels: [process.env.FUSION_RESEARCH_MODEL ?? "deepseek/deepseek-v4-pro"],
    judgeModel: defaultJudgeModel,
    outerModel: defaultOuterModel,
    webEnabled: true,
    localToolsEnabled: true,
    maxToolCalls: 8
  },
  "fusion-3": {
    mode: "fusion-3",
    alias: "fusion/fusion-3",
    shortAlias: "fusion-3",
    compatibleAliases: [
      "fusion/fusion",
      "fusion/fusion-3",
      "openrouter/fusion",
      "fusion"
    ],
    description: "Three-model fusion plus judge and synthesis.",
    panelModels: fusion3Models,
    judgeModel: defaultJudgeModel,
    outerModel: defaultOuterModel,
    webEnabled: true,
    localToolsEnabled: true,
    maxToolCalls: 8
  },
  "fusion-8": {
    mode: "fusion-8",
    alias: "fusion/fusion-8",
    shortAlias: "fusion-8",
    compatibleAliases: ["fusion/fusion-8"],
    description: "Eight-model fusion plus judge and synthesis.",
    panelModels: fusion8Models,
    judgeModel: defaultJudgeModel,
    outerModel: defaultOuterModel,
    webEnabled: true,
    localToolsEnabled: true,
    maxToolCalls: 8
  }
};

export type CompatPreset = Pick<
  FusionPreset,
  "panelModels" | "judgeModel" | "outerModel" | "maxToolCalls"
>;

// OpenRouter Fusion preset slugs: high = strongest families, budget = cheaper
// panel with the same frontier judge, fast = quick low-cost panel.
export const COMPAT_PRESETS: Record<string, CompatPreset> = {
  "general-high": {
    panelModels: fusion3Models,
    judgeModel: defaultJudgeModel,
    outerModel: defaultOuterModel,
    maxToolCalls: 8
  },
  "general-budget": {
    panelModels: [
      "google/gemini-3.5-flash",
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4-flash"
    ],
    judgeModel: defaultJudgeModel,
    outerModel: defaultOuterModel,
    maxToolCalls: 8
  },
  "general-fast": {
    panelModels: ["google/gemini-3.5-flash", "deepseek/deepseek-v4-flash"],
    judgeModel: defaultJudgeModel,
    outerModel: defaultOuterModel,
    maxToolCalls: 8
  }
};

export function modeFromModel(model?: string): FusionMode {
  if (!model) {
    return "openfusion";
  }
  const builtInMode = BUILT_IN_ALIAS_TO_MODE[normalizeLegacyAlias(model)];
  if (builtInMode) {
    return builtInMode;
  }

  const customMode = clientModelAliases().find((entry) => entry.alias === model)?.mode;
  if (customMode) {
    return customMode;
  }

  throw new Error(
    `Unsupported Fusion model alias "${model}". Use openfusion, fusion, openrouter/fusion, or configure FUSION_MODEL_ALIASES.`
  );
}
