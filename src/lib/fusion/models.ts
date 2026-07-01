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

// Ordered so the first three are the distinct frontier families OpenRouter's
// Quality (`general-high`) Fusion panel uses by default — Anthropic, OpenAI,
// Google — since the 3-model panel is `fusion8Models.slice(0, 3)`.
const fusion8Models = [
  "anthropic/claude-opus-4.8",
  "openai/gpt-5.5",
  "google/gemini-3-pro-preview",
  "anthropic/claude-sonnet-4.6",
  "deepseek/deepseek-v4-pro",
  "google/gemini-3.5-flash",
  "alibaba/qwen3.7-max",
  "deepseek/deepseek-v4-flash"
];

function modelListFromEnv(name: string, fallback: string[]) {
  const configured = process.env[name]
    ?.split(/[,\n]/)
    .map((model) => model.trim())
    .filter(Boolean);

  return configured?.length ? configured.slice(0, 8) : fallback;
}

const defaultFastModel = process.env.FUSION_FAST_MODEL ?? "google/gemini-3.5-flash";
const defaultJudgeModel = process.env.FUSION_JUDGE_MODEL ?? "openai/gpt-5.5";
const defaultOuterModel =
  process.env.FUSION_OUTER_MODEL ?? "anthropic/claude-opus-4.8";
const configuredFusion8Models = modelListFromEnv("FUSION_FUSION8_MODELS", fusion8Models);
const configuredFusion3Models = modelListFromEnv(
  "FUSION_FUSION3_MODELS",
  configuredFusion8Models.slice(0, 3)
);

const BUILT_IN_ALIAS_TO_MODE: Record<string, FusionMode> = {
  "fusion/fast": "fast",
  fast: "fast",
  "fusion/research": "research",
  research: "research",
  "openrouter/fusion": "fusion-3",
  "fusion/fusion": "fusion-3",
  fusion: "fusion-3",
  openfusion: "fusion-3",
  "fusion/fusion-3": "fusion-3",
  "fusion-3": "fusion-3",
  "fusion/fusion-8": "fusion-8",
  "fusion-8": "fusion-8"
};

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

export const FUSION_PRESETS: Record<FusionMode, FusionPreset> = {
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
    panelModels: configuredFusion3Models,
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
    panelModels: configuredFusion8Models,
    judgeModel: defaultJudgeModel,
    outerModel: defaultOuterModel,
    webEnabled: true,
    localToolsEnabled: true,
    maxToolCalls: 8
  }
};

export function modeFromModel(model?: string): FusionMode {
  if (!model) {
    return "fusion-3";
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
    `Unsupported Fusion model alias "${model}". Use fusion/fast, fusion/research, fusion/fusion-3, fusion/fusion-8, openrouter/fusion, fusion/fusion, the short aliases fast, research, fusion, fusion-3, fusion-8, or configure FUSION_MODEL_ALIASES.`
  );
}
