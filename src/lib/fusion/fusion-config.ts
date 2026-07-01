import {
  FusionOverrideSchema,
  OpenAIClientFunctionToolSchema,
  WebFetchConfigSchema,
  WebSearchConfigSchema,
  type FusionOverride,
  type OpenAIClientFunctionTool,
  type OpenAIChatCompletionRequest
} from "./schemas.ts";
import { FUSION_PRESETS } from "./models.ts";
import { z } from "zod";

type RawObject = Record<string, unknown>;

function asObject(value: unknown): RawObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RawObject)
    : undefined;
}

const FusionParametersSchema = FusionOverrideSchema.extend({
  analysis_models: FusionOverrideSchema.shape.panel_models,
  model: FusionOverrideSchema.shape.judge_model,
  enabled: z.boolean(),
  preset: z.string().min(1)
}).partial();

function presetFusionParameters(preset: unknown) {
  if (preset === "general-high") {
    return FUSION_PRESETS["fusion-8"];
  }

  if (preset === "general-budget") {
    return FUSION_PRESETS["fusion-3"];
  }

  return undefined;
}

function normalizeFusionParameters(
  value: unknown,
  source = "Fusion parameters"
): FusionOverride | undefined {
  const parsed = FusionParametersSchema.safeParse(value);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${source} are invalid: ${message}`);
  }

  const parameters = parsed.data;
  const preset = presetFusionParameters(parameters.preset);
  const override = FusionOverrideSchema.parse({
    panel_models:
      parameters.panel_models ?? parameters.analysis_models ?? preset?.panelModels,
    judge_model: parameters.judge_model ?? parameters.model ?? preset?.judgeModel,
    outer_model: parameters.outer_model ?? preset?.outerModel,
    max_tool_calls: parameters.max_tool_calls ?? preset?.maxToolCalls,
    max_completion_tokens: parameters.max_completion_tokens,
    reasoning: parameters.reasoning,
    temperature: parameters.temperature,
    force: parameters.force,
    disabled: parameters.enabled === false ? true : parameters.disabled,
    strict: parameters.strict,
    web_search: parameters.web_search,
    web_fetch: parameters.web_fetch
  });

  return Object.values(override).some((entry) => entry !== undefined)
    ? override
    : undefined;
}

function pluginFusionOverride(plugins: OpenAIChatCompletionRequest["plugins"]) {
  const plugin = plugins
    ?.map(asObject)
    .find((entry) => entry?.id === "fusion");

  if (!plugin) {
    return undefined;
  }

  return normalizeFusionParameters(plugin, "Fusion plugin parameters");
}

function hasFusionPlugin(plugins: OpenAIChatCompletionRequest["plugins"]) {
  return Boolean(plugins?.map(asObject).some((entry) => entry?.id === "fusion"));
}

function isOpenRouterFusionTool(entry: RawObject | undefined) {
  return entry?.type === "openrouter:fusion";
}

function isFusionTool(entry: RawObject | undefined) {
  return entry?.type === "fusion:fusion";
}

function isWebSearchTool(entry: RawObject | undefined) {
  return entry?.type === "openrouter:web_search";
}

function isWebFetchTool(entry: RawObject | undefined) {
  return entry?.type === "openrouter:web_fetch";
}

function toolFusionOverride(tools: OpenAIChatCompletionRequest["tools"]) {
  const tool = tools
    ?.map(asObject)
    .find(
      (entry) =>
        isOpenRouterFusionTool(entry) || isFusionTool(entry)
    );

  if (!tool) {
    return undefined;
  }

  return normalizeFusionParameters(tool.parameters ?? tool, "Fusion tool parameters") ?? {};
}

function hasFusionTool(tools: OpenAIChatCompletionRequest["tools"]) {
  return Boolean(
    tools
      ?.map(asObject)
      .some(
        (entry) =>
          isOpenRouterFusionTool(entry) || isFusionTool(entry)
      )
  );
}

function hasOpenRouterFusionTool(tools: OpenAIChatCompletionRequest["tools"]) {
  return Boolean(tools?.map(asObject).some(isOpenRouterFusionTool));
}

function parseWebToolParameters<T>(
  value: unknown,
  schema: { parse: (value: unknown) => T },
  source: string
) {
  try {
    return schema.parse(value ?? {});
  } catch (error) {
    if (error instanceof z.ZodError) {
      const message = error.issues
        .map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`)
        .join("; ");
      throw new Error(`${source} are invalid: ${message}`);
    }
    throw error;
  }
}

function webToolOverrides(tools: OpenAIChatCompletionRequest["tools"]) {
  let webSearch: FusionOverride["web_search"];
  let webFetch: FusionOverride["web_fetch"];

  for (const tool of tools?.map(asObject) ?? []) {
    if (!tool) {
      continue;
    }

    if (isWebSearchTool(tool)) {
      webSearch = parseWebToolParameters(
        tool.parameters,
        WebSearchConfigSchema,
        "Web search tool parameters"
      );
    }

    if (isWebFetchTool(tool)) {
      webFetch = parseWebToolParameters(
        tool.parameters,
        WebFetchConfigSchema,
        "Web fetch tool parameters"
      );
    }
  }

  return webSearch || webFetch
    ? {
        web_search: webSearch,
        web_fetch: webFetch
      }
    : undefined;
}

function toolLabel(value: RawObject | undefined) {
  const type = value?.type;
  if (typeof type === "string" && type.trim()) {
    return type;
  }

  const name = asObject(value?.function)?.name;
  if (typeof name === "string" && name.trim()) {
    return `function:${name}`;
  }

  return "unknown_tool";
}

function unsupportedClientTools(request: OpenAIChatCompletionRequest) {
  return (request.tools ?? [])
    .map(asObject)
    .filter(
      (entry) =>
        !isOpenRouterFusionTool(entry) &&
        !isFusionTool(entry) &&
        !isWebSearchTool(entry) &&
        !isWebFetchTool(entry) &&
        entry?.type !== "function"
    )
    .map(toolLabel);
}

export function clientFunctionTools(
  request: OpenAIChatCompletionRequest
): OpenAIClientFunctionTool[] {
  const tools = (request.tools ?? [])
    .map((entry) => OpenAIClientFunctionToolSchema.safeParse(entry))
    .filter((entry) => entry.success)
    .map((entry) => entry.data);
  const seen = new Set<string>();

  for (const entry of tools) {
    const name = entry.function.name;
    if (
      name === "fusionTool" ||
      name.startsWith("openrouter:") ||
      name.startsWith("fusion:")
    ) {
      throw new Error(
        `Client function tool name "${name}" is reserved by the Fusion runtime.`
      );
    }
    if (seen.has(name)) {
      throw new Error(`Duplicate client function tool name "${name}".`);
    }
    seen.add(name);
  }

  return tools;
}

function clientToolNames(request: OpenAIChatCompletionRequest) {
  return new Set(clientFunctionTools(request).map((entry) => entry.function.name));
}

function hasClientFunctionTools(request: OpenAIChatCompletionRequest) {
  return clientFunctionTools(request).length > 0;
}

export function hasClientToolTranscript(request: OpenAIChatCompletionRequest) {
  return request.messages.some(
    (message) => message.role === "tool" || Boolean(message.tool_calls?.length)
  );
}

export function assertSupportedClientTools(request: OpenAIChatCompletionRequest) {
  const unsupportedTools = unsupportedClientTools(request);
  if (unsupportedTools.length > 0) {
    throw new Error(
      `Unsupported client tools: ${unsupportedTools.join(", ")}. Fusion accepts openrouter:fusion/fusion:fusion server tools plus OpenAI function tools on the agentic Fusion path.`
    );
  }

  clientFunctionTools(request);

  const choice = asObject(request.tool_choice);
  if (choice) {
    if (isOpenRouterFusionTool(choice) || isFusionTool(choice)) {
      return;
    }

    const forcedFunction = asObject(choice.function)?.name;
    if (
      choice.type === "function" &&
      typeof forcedFunction === "string" &&
      clientToolNames(request).has(forcedFunction)
    ) {
      return;
    }

    throw new Error(
      "Unsupported tool_choice. Fusion accepts tool_choice: \"required\", \"auto\", \"none\", an openrouter:fusion/fusion:fusion tool choice, or a named OpenAI function tool choice on the agentic Fusion path."
    );
  }
}

function isAgenticFusionAlias(model: string) {
  return (
    model === "openrouter/fusion" || model === "fusion/fusion"
  );
}

function isSpecificFusionChoice(toolChoice: OpenAIChatCompletionRequest["tool_choice"]) {
  const value = asObject(toolChoice);
  return isOpenRouterFusionTool(value) || isFusionTool(value);
}

export function forced(request: OpenAIChatCompletionRequest) {
  if (isSpecificFusionChoice(request.tool_choice)) {
    return true;
  }

  if (request.tool_choice !== "required") {
    return false;
  }

  return !hasClientFunctionTools(request);
}

function strictFusion(request: OpenAIChatCompletionRequest) {
  return (
    request.model === "openrouter/fusion" ||
    request.model === "fusion/fusion" ||
    hasOpenRouterFusionTool(request.tools) ||
    hasFusionTool(request.tools) ||
    hasFusionPlugin(request.plugins)
  );
}

export function shouldUseAgenticFusion(request: OpenAIChatCompletionRequest) {
  return (
    isAgenticFusionAlias(request.model) ||
    hasFusionTool(request.tools) ||
    hasClientFunctionTools(request) ||
    hasClientToolTranscript(request)
  );
}

export function fusionOverrideFromOpenAIRequest(
  request: OpenAIChatCompletionRequest
): FusionOverride | undefined {
  const plugin = pluginFusionOverride(request.plugins);
  const tool = toolFusionOverride(request.tools);
  const webTools = webToolOverrides(request.tools);
  const force = forced(request);
  const strict = strictFusion(request);

  if (!plugin && !tool && !webTools && !request.reasoning && !force && !strict) {
    return undefined;
  }

  const explicitTool = Boolean(tool);
  const disabled = explicitTool ? tool?.disabled : plugin?.disabled;

  return FusionOverrideSchema.parse({
    ...plugin,
    ...tool,
    reasoning: tool?.reasoning ?? plugin?.reasoning ?? request.reasoning,
    disabled,
    force: disabled ? false : force || tool?.force || plugin?.force,
    strict: tool?.strict ?? plugin?.strict ?? strict,
    web_search: webTools?.web_search ?? tool?.web_search ?? plugin?.web_search,
    web_fetch: webTools?.web_fetch ?? tool?.web_fetch ?? plugin?.web_fetch
  });
}
