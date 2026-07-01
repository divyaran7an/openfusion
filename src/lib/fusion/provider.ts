import { createGateway, gateway as defaultGateway } from "@ai-sdk/gateway";
import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { extractTool } from "@parallel-web/ai-sdk-tools";
import {
  generateText,
  jsonSchema,
  Output,
  stepCountIs,
  streamText,
  tool,
  type ToolSet
} from "ai";
import { z } from "zod";
import { getStoredGatewayKey, getStoredOpenRouterKey } from "./credentials.ts";
import { FusionConfigurationError } from "./errors.ts";
import { gatewayProbeReason } from "./gateway-status.ts";
import { shortId } from "./ids.ts";
import { hasLocalTools } from "./local-tools-config.ts";
import {
  enrichProviderCallMetadata,
  providerCallMetadata
} from "./provider-metadata.ts";
import { openRouterProviderToolsFor } from "./openrouter-tools.ts";
import {
  AnalysisSchema,
  type FusionAnalysis,
  type OpenAIClientFunctionTool,
  type OpenAIClientToolCall,
  type ProviderCallMetadata,
  type WebFetchConfig,
  type WebSearchConfig
} from "./schemas.ts";
import type {
  EffortLevel,
  FusionResult,
  ModelCallOptions,
  NodeToolReport,
  PanelResponse,
  SourceRecord,
  UsageRecord
} from "./types.ts";
import { hasWebFetchTool, webFetchToolFor } from "./web-tools.ts";
import { harnessProviders, type HarnessProviderId } from "./harness.ts";
import {
  requiredBackends,
  resolveModelTarget,
  type ModelTarget
} from "./model-routing.ts";

export { hasLocalTools } from "./local-tools-config.ts";
export { hasWebFetchTool } from "./web-tools.ts";
export { FusionConfigurationError } from "./errors.ts";

// Resolve the Vercel AI Gateway provider, preferring a key the user set in the studio over
// the environment. The provider is memoized by key so a save takes effect on the
// very next request — no restart — while unchanged runs reuse one instance. With
// no stored key we fall back to the default provider, which reads
// AI_GATEWAY_API_KEY / VERCEL_OIDC_TOKEN itself.
let cachedGateway: { key: string; provider: ReturnType<typeof createGateway> } | null = null;
let cachedOpenRouter: {
  key: string;
  appName?: string;
  appUrl?: string;
  provider: ReturnType<typeof createOpenRouter>;
} | null = null;

function gateway(model: string) {
  const stored = getStoredGatewayKey();
  if (!stored) {
    return defaultGateway(model);
  }
  if (cachedGateway?.key !== stored) {
    cachedGateway = { key: stored, provider: createGateway({ apiKey: stored }) };
  }
  return cachedGateway.provider(model);
}

/** The resolved Vercel AI Gateway provider object (for `.tools` / `.getGenerationInfo`). */
function gatewayProvider() {
  const stored = getStoredGatewayKey();
  if (!stored) {
    return defaultGateway;
  }
  if (cachedGateway?.key !== stored) {
    cachedGateway = { key: stored, provider: createGateway({ apiKey: stored }) };
  }
  return cachedGateway.provider;
}

function openRouterProvider() {
  const key = getStoredOpenRouterKey() ?? process.env.OPENROUTER_API_KEY;
  const appName = process.env.OPENROUTER_APP_TITLE || "OpenFusion";
  const appUrl = process.env.OPENROUTER_HTTP_REFERER || undefined;
  if (cachedOpenRouter?.key !== key || cachedOpenRouter?.appName !== appName || cachedOpenRouter?.appUrl !== appUrl) {
    cachedOpenRouter = {
      key: key ?? "",
      appName,
      appUrl,
      provider: createOpenRouter({
        apiKey: key,
        appName,
        appUrl
      })
    };
  }
  return cachedOpenRouter.provider;
}

function openRouterModel(model: string) {
  return openRouterProvider().chat(model, {
    usage: {
      include: true
    }
  });
}

export function hasRuntimeCredentials() {
  // A studio-set key, or the two credentials the AI SDK's gateway provider reads
  // itself — so the pre-flight check matches what the actual call can use.
  return Boolean(
    getStoredGatewayKey() ||
      process.env.AI_GATEWAY_API_KEY ||
      process.env.VERCEL_OIDC_TOKEN
  );
}

export function hasOpenRouterCredentials() {
  return Boolean(getStoredOpenRouterKey() || process.env.OPENROUTER_API_KEY);
}

export function hasWebCredentials() {
  return hasRuntimeCredentials();
}

export type GatewayProbe = { ok: boolean; reason?: string };

let gatewayProbeCache: { signature: string; at: number; result: GatewayProbe } | null = null;
let gatewayProbeInflight: { signature: string; promise: Promise<GatewayProbe> } | null = null;
let openRouterProbeCache: { signature: string; at: number; result: GatewayProbe } | null = null;
let openRouterProbeInflight: { signature: string; promise: Promise<GatewayProbe> } | null = null;
const GATEWAY_PROBE_TTL_MS = 30_000;
const GATEWAY_PROBE_TIMEOUT_MS = 8_000;

async function runGatewayProbe(deep: boolean, model: string | undefined): Promise<GatewayProbe> {
  // `getCredits` validates the key (auth) without a billable inference call. The
  // deep probe runs a tiny generation to catch per-key spend caps that credits
  // can't see, so it's reserved for explicit studio health checks.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATEWAY_PROBE_TIMEOUT_MS);
  try {
    if (deep && model) {
      await generateText({
        model: gateway(model),
        prompt: "ping",
        maxOutputTokens: 16,
        abortSignal: controller.signal
      });
    } else {
      await Promise.race([
        gatewayProvider().getCredits(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Vercel AI Gateway probe timed out.")), GATEWAY_PROBE_TIMEOUT_MS)
        )
      ]);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: gatewayProbeReason(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verify Vercel AI Gateway is usable — not merely that a key string exists.
 *
 * `deep: true` (with a model) runs a tiny generation, the only check that
 * reflects real runnability including a per-key spend cap. It costs a token, so the
 * studio opts into it explicitly; the default does a free `getCredits` auth check.
 * Results are cached for 30s (keyed by resolved key + model + depth, so a key or
 * model change re-probes), and concurrent callers share one in-flight probe so a
 * burst of requests never fans out into many billable generations.
 */
export async function probeGatewayConnectivity(
  options: { model?: string; deep?: boolean } = {}
): Promise<GatewayProbe> {
  if (!hasRuntimeCredentials()) {
    return { ok: false, reason: "No Vercel AI Gateway key set." };
  }
  const deep = Boolean(options.deep && options.model);
  const keyId = getStoredGatewayKey() ?? process.env.AI_GATEWAY_API_KEY ?? "oidc";
  const signature = `${keyId}:${deep ? options.model : "credits"}`;
  const now = Date.now();

  if (
    gatewayProbeCache &&
    gatewayProbeCache.signature === signature &&
    now - gatewayProbeCache.at < GATEWAY_PROBE_TTL_MS
  ) {
    return gatewayProbeCache.result;
  }
  if (gatewayProbeInflight?.signature === signature) {
    return gatewayProbeInflight.promise;
  }

  const promise = runGatewayProbe(deep, options.model).then((result) => {
    gatewayProbeCache = { signature, at: Date.now(), result };
    return result;
  });
  gatewayProbeInflight = { signature, promise };
  try {
    return await promise;
  } finally {
    if (gatewayProbeInflight?.signature === signature) {
      gatewayProbeInflight = null;
    }
  }
}

async function runOpenRouterProbe(deep: boolean, model: string | undefined): Promise<GatewayProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATEWAY_PROBE_TIMEOUT_MS);
  try {
    if (deep && model) {
      await generateText({
        model: openRouterModel(model),
        prompt: "ping",
        maxOutputTokens: 16,
        abortSignal: controller.signal
      });
    } else {
      const key = getStoredOpenRouterKey() ?? process.env.OPENROUTER_API_KEY;
      const response = await fetch("https://openrouter.ai/api/v1/key", {
        headers: { authorization: `Bearer ${key}` },
        signal: controller.signal
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `OpenRouter key probe failed (${response.status} ${response.statusText})${body ? `: ${body.slice(0, 240)}` : ""}`
        );
      }
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: gatewayProbeReason(error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeOpenRouterConnectivity(
  options: { model?: string; deep?: boolean } = {}
): Promise<GatewayProbe> {
  if (!hasOpenRouterCredentials()) {
    return { ok: false, reason: "No OpenRouter key set." };
  }

  const deep = Boolean(options.deep && options.model);
  const keyId = getStoredOpenRouterKey() ?? process.env.OPENROUTER_API_KEY ?? "none";
  const signature = `${keyId}:${deep ? options.model : "key"}`;
  const now = Date.now();

  if (
    openRouterProbeCache &&
    openRouterProbeCache.signature === signature &&
    now - openRouterProbeCache.at < GATEWAY_PROBE_TTL_MS
  ) {
    return openRouterProbeCache.result;
  }
  if (openRouterProbeInflight?.signature === signature) {
    return openRouterProbeInflight.promise;
  }

  const promise = runOpenRouterProbe(deep, options.model).then((result) => {
    openRouterProbeCache = { signature, at: Date.now(), result };
    return result;
  });
  openRouterProbeInflight = { signature, promise };
  try {
    return await promise;
  } finally {
    if (openRouterProbeInflight?.signature === signature) {
      openRouterProbeInflight = null;
    }
  }
}

export function hasParallelExtractCredentials() {
  return Boolean(process.env.PARALLEL_API_KEY);
}

function supportsGatewaySearchTools(model: string) {
  return !model.startsWith("meta/");
}

export function hasWebToolsFor(model: string, webEnabled: boolean) {
  if (!webEnabled) {
    return false;
  }
  const target = resolveModelTarget(model);
  if (target.kind === "openrouter") {
    return hasOpenRouterCredentials();
  }
  if (target.kind === "gateway") {
    return (hasWebCredentials() && supportsGatewaySearchTools(target.model)) || hasWebFetchTool();
  }
  const provider = harnessProviders().find((entry) => entry.id === target.harness);
  return provider?.status === "ready";
}

export function hasWebFetchFor(model: string, webEnabled: boolean) {
  if (!webEnabled) {
    return false;
  }
  const target = resolveModelTarget(model);
  if (target.kind === "openrouter") {
    return hasOpenRouterCredentials();
  }
  if (target.kind === "gateway") {
    return hasWebFetchTool();
  }
  if (target.harness === "claude-code") {
    const provider = harnessProviders().find((entry) => entry.id === target.harness);
    return provider?.status === "ready";
  }
  return false;
}

function assertRuntimeCredentials() {
  if (!hasRuntimeCredentials()) {
    throw new FusionConfigurationError(
      "OpenFusion needs a Vercel AI Gateway key before it can run Vercel AI Gateway models. Add one in the studio (click the Vercel AI Gateway chip) or set AI_GATEWAY_API_KEY."
    );
  }
}

function assertOpenRouterCredentials() {
  if (!hasOpenRouterCredentials()) {
    throw new FusionConfigurationError(
      "Fusion needs an OpenRouter key before it can run OpenRouter models. Add one in the studio (click the OpenRouter chip) or set OPENROUTER_API_KEY."
    );
  }
}

function gatewayGenerationLookupEnabled() {
  return process.env.FUSION_GATEWAY_GENERATION_LOOKUP !== "0";
}

function openRouterGenerationLookupEnabled() {
  return process.env.FUSION_OPENROUTER_GENERATION_LOOKUP !== "0";
}

async function openRouterGenerationInfo(id: string) {
  const key = getStoredOpenRouterKey() ?? process.env.OPENROUTER_API_KEY;
  if (!key) {
    return undefined;
  }

  const response = await fetch(
    `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(id)}`,
    { headers: { authorization: `Bearer ${key}` } }
  );
  if (!response.ok) {
    throw new Error(`OpenRouter generation lookup failed (${response.status} ${response.statusText}).`);
  }
  const body = await response.json();
  return asRecord(body).data ?? body;
}

type HostedTarget = Exclude<ModelTarget, { kind: "harness" }>;

function hostedModel(target: HostedTarget) {
  return target.kind === "openrouter" ? openRouterModel(target.model) : gateway(target.model);
}

function hostedProviderOptions(
  target: HostedTarget,
  effort?: EffortLevel,
  web?: { enabled?: boolean; search?: WebSearchConfig; fetch?: WebFetchConfig }
): SharedV3ProviderOptions | undefined {
  return target.kind === "openrouter"
    ? openRouterProviderOptions(effort)
    : gatewayProviderOptions(target.model, effort);
}

function hostedToolChoice(target: HostedTarget, tools: ToolSet | undefined) {
  return target.kind === "openrouter" && tools && Object.keys(tools).length > 0
    ? ("auto" as const)
    : undefined;
}

function assertHostedCredentials(target: HostedTarget) {
  if (target.kind === "openrouter") {
    assertOpenRouterCredentials();
  } else {
    assertRuntimeCredentials();
  }
}

async function providerMetadataForResult(
  result: unknown,
  model: string,
  target: HostedTarget
) {
  const metadata = providerCallMetadata(result, model, target.kind);
  if (!metadata?.generation_id) {
    return metadata;
  }

  if (target.kind === "openrouter") {
    if (!openRouterGenerationLookupEnabled()) {
      return metadata;
    }
    try {
      return enrichProviderCallMetadata(
        metadata,
        await openRouterGenerationInfo(metadata.generation_id)
      );
    } catch {
      return metadata;
    }
  }

  if (!gatewayGenerationLookupEnabled()) {
    return metadata;
  }
  try {
    return enrichProviderCallMetadata(
      metadata,
      await gatewayProvider().getGenerationInfo({ id: metadata.generation_id })
    );
  } catch {
    return metadata;
  }
}

function normalizeUsage(usage: unknown): UsageRecord {
  const value = (usage ?? {}) as Record<string, unknown>;
  const input =
    Number(value.inputTokens ?? value.promptTokens ?? value.input_tokens ?? 0) || 0;
  const output =
    Number(value.outputTokens ?? value.completionTokens ?? value.output_tokens ?? 0) || 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function sourceMetadata(value: Record<string, unknown>) {
  const nested = asRecord(value.metadata);
  const metadata: Record<string, unknown> = {
    ...nested
  };

  for (const key of [
    "canonical_url",
    "site_name",
    "published_at",
    "fetched_at",
    "mime_type",
    "status"
  ]) {
    if (value[key] !== undefined && metadata[key] === undefined) {
      metadata[key] = value[key];
    }
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function firstSnippet(value: Record<string, unknown>) {
  const snippet = optionalString(value.snippet);
  if (snippet) {
    return snippet;
  }

  const text = optionalString(value.text);
  if (text) {
    return text.slice(0, 280);
  }

  const excerpt = optionalString(value.excerpt);
  if (excerpt) {
    return excerpt.slice(0, 280);
  }

  if (Array.isArray(value.excerpts)) {
    return value.excerpts
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .join("\n")
      .slice(0, 280);
  }

  return undefined;
}

function normalizeProviderSources(sources: unknown): SourceRecord[] {
  if (!Array.isArray(sources)) {
    return [];
  }

  return sources.slice(0, 12).map((source) => {
    const value = asRecord(source);
    return {
      title: String(value.title ?? value.sourceType ?? "Source"),
      url: optionalString(value.url),
      snippet: firstSnippet(value),
      provider: typeof value.provider === "string" ? value.provider : "ai-sdk",
      metadata: sourceMetadata(value)
    };
  });
}

function toolResultsFrom(result: unknown) {
  const value = asRecord(result);
  const direct = Array.isArray(value.toolResults) ? value.toolResults : [];
  const stepped = Array.isArray(value.steps)
    ? value.steps.flatMap((step) => {
        const stepRecord = asRecord(step);
        return Array.isArray(stepRecord.toolResults) ? stepRecord.toolResults : [];
      })
    : [];

  return [...direct, ...stepped];
}

function toolCallsFrom(result: unknown) {
  const value = asRecord(result);
  const direct = Array.isArray(value.toolCalls) ? value.toolCalls : [];
  const stepped = Array.isArray(value.steps)
    ? value.steps.flatMap((step) => {
        const stepRecord = asRecord(step);
        return Array.isArray(stepRecord.toolCalls) ? stepRecord.toolCalls : [];
      })
    : [];

  return [...direct, ...stepped];
}

/**
 * Build an `onStepFinish` handler that reports each tool call a model made to
 * `onTool` as soon as its step settles — so the studio renders tool activity
 * live, per node, instead of only after the whole call resolves. The AI SDK
 * hands every step its own `toolCalls` + `toolResults`; we pair them by id and
 * surface the call's input (the query/url) and the tool's output (the results).
 */
function toolStepReporter(onTool: ((report: NodeToolReport) => void) | undefined) {
  if (!onTool) return undefined;
  return (step: unknown) => {
    const record = asRecord(step);
    const calls = Array.isArray(record.toolCalls) ? record.toolCalls : [];
    const results = Array.isArray(record.toolResults) ? record.toolResults : [];
    for (const rawCall of calls) {
      const call = asRecord(rawCall);
      const tool = optionalString(call.toolName);
      if (!tool) continue;
      const callId = optionalString(call.toolCallId) ?? tool;
      const match = results
        .map(asRecord)
        .find((entry) => optionalString(entry.toolCallId) === callId);
      const output = match ? asRecord(match.output) : undefined;
      onTool({
        tool,
        call_id: callId,
        args: call.input,
        result: match?.output,
        is_error: Boolean(match?.output) && "error" in (output ?? {})
      });
    }
  };
}

function normalizeToolSources(result: unknown): SourceRecord[] {
  return toolResultsFrom(result).flatMap((toolResult) => {
    const tool = asRecord(toolResult);
    const output = asRecord(tool.output);
    const results = Array.isArray(output.results) ? output.results : [];
    const provider =
      optionalString(tool.toolName) === "webSearch"
        ? "gateway.parallel_search"
        : optionalString(tool.toolName) ?? "gateway.search";

    return results.map((entry) => {
      const source = asRecord(entry);
      return {
        title: optionalString(source.title) ?? optionalString(source.url) ?? "Source",
        url: optionalString(source.url),
        snippet: firstSnippet(source),
        provider,
        metadata: sourceMetadata(source)
      };
    });
  });
}

function normalizeSources(result: unknown): SourceRecord[] {
  const value = asRecord(result);
  const combined = [
    ...normalizeProviderSources(value.sources),
    ...normalizeToolSources(result)
  ];
  const seen = new Set<string>();

  return combined
    .filter((source) => {
      const key = source.url ?? `${source.title}:${source.snippet}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 12);
}

function summarizeSources(sources: SourceRecord[]) {
  if (sources.length === 0) {
    return "";
  }

  return [
    "Web search returned these sources:",
    ...sources.slice(0, 5).map((source, index) => {
      const locator = source.url ? ` - ${source.url}` : "";
      const snippet = source.snippet ? `: ${source.snippet}` : "";
      return `${index + 1}. ${source.title ?? "Source"}${locator}${snippet}`;
    })
  ].join("\n");
}

function optionalCountry(value: unknown) {
  const location = asRecord(value);
  const country =
    optionalString(location.country_code) ??
    optionalString(location.countryCode) ??
    optionalString(location.country);
  return country?.length === 2 ? country.toUpperCase() : undefined;
}

function boundedSearchResults(config?: WebSearchConfig) {
  return Math.min(config?.max_results ?? config?.max_total_results ?? 10, 20);
}

function searchDomainFilter(config?: WebSearchConfig) {
  const allowed = config?.allowed_domains ?? [];
  const excluded = config?.excluded_domains ?? [];
  const filter = [
    ...allowed,
    ...excluded.map((domain) => `-${domain}`)
  ];

  return filter.length > 0 ? filter.slice(0, 20) : undefined;
}

function parallelSearchConfig(config?: WebSearchConfig) {
  if (!config) {
    return undefined;
  }

  return {
    mode: config.search_context_size === "low" ? "agentic" as const : "one-shot" as const,
    maxResults: boundedSearchResults(config),
    sourcePolicy: {
      includeDomains: config.allowed_domains,
      excludeDomains: config.excluded_domains
    },
    excerpts: {
      maxCharsTotal: config.max_characters,
      maxCharsPerResult:
        config.max_characters && config.max_results
          ? Math.ceil(config.max_characters / config.max_results)
          : undefined
    }
  };
}

function perplexitySearchConfig(config?: WebSearchConfig) {
  if (!config) {
    return undefined;
  }

  return {
    maxResults: boundedSearchResults(config),
    maxTokens: config.max_characters
      ? Math.ceil(config.max_characters / 4)
      : undefined,
    country: optionalCountry(config.user_location),
    searchDomainFilter: searchDomainFilter(config)
  };
}

function gatewaySearchTool(config?: WebSearchConfig) {
  if (config?.engine === "perplexity") {
    return gatewayProvider().tools.perplexitySearch(perplexitySearchConfig(config));
  }

  return gatewayProvider().tools.parallelSearch(parallelSearchConfig(config));
}

function webToolsFor(
  model: string,
  webEnabled: boolean,
  config: { search?: WebSearchConfig; fetch?: WebFetchConfig } = {}
): ToolSet | undefined {
  const target = resolveModelTarget(model);
  if (target.kind === "openrouter") {
    return openRouterProviderToolsFor({
      enabled: webEnabled,
      search: config.search,
      fetch: config.fetch
    });
  }

  if (target.kind === "harness") {
    return webFetchToolFor(webEnabled, config.fetch) as ToolSet | undefined;
  }

  const gatewayToolsAvailable =
    webEnabled && hasWebCredentials() && supportsGatewaySearchTools(target.model);
  const fetchTool = webFetchToolFor(webEnabled, config.fetch);

  if (!gatewayToolsAvailable && !fetchTool) {
    return undefined;
  }

  return {
    ...(gatewayToolsAvailable ? { webSearch: gatewaySearchTool(config.search) } : {}),
    ...(gatewayToolsAvailable && hasParallelExtractCredentials()
      ? { webExtract: extractTool }
      : {}),
    ...(fetchTool ?? {})
  } as ToolSet;
}

async function localToolsForEnabled(localToolsEnabled: boolean) {
  if (!localToolsEnabled || !hasLocalTools()) {
    return undefined;
  }

  const { localToolsFor } = await import("./local-tools.ts");
  return localToolsFor(true);
}

async function toolsFor(
  model: string,
  webEnabled: boolean,
  localToolsEnabled: boolean,
  webConfig: { search?: WebSearchConfig; fetch?: WebFetchConfig } = {}
) {
  const webTools = webToolsFor(model, webEnabled, webConfig);
  const localTools = await localToolsForEnabled(localToolsEnabled);

  if (!webTools && !localTools) {
    return undefined;
  }

  return {
    ...(webTools ?? {}),
    ...(localTools ?? {})
  };
}

function safeJsonObjectSchema(value: unknown) {
  const schema = asRecord(value);
  return Object.keys(schema).length > 0
    ? schema
    : {
        type: "object",
        properties: {}
      };
}

function aiSdkClientTools(clientTools: OpenAIClientFunctionTool[] | undefined) {
  if (!clientTools?.length) {
    return {};
  }

  return Object.fromEntries(
    clientTools.map((clientTool) => [
      clientTool.function.name,
      tool({
        description: clientTool.function.description,
        inputSchema: jsonSchema(
          safeJsonObjectSchema(clientTool.function.parameters) as Parameters<
            typeof jsonSchema
          >[0]
        )
      })
    ])
  );
}

function aiSdkToolChoice(options: {
  forceFusion: boolean;
  fusionEnabled: boolean;
  clientToolChoice?: unknown;
}) {
  if (options.forceFusion && options.fusionEnabled) {
    return {
      type: "tool" as const,
      toolName: "fusionTool"
    };
  }

  if (
    options.clientToolChoice === "required" ||
    options.clientToolChoice === "none" ||
    options.clientToolChoice === "auto"
  ) {
    return options.clientToolChoice;
  }

  const choice = asRecord(options.clientToolChoice);
  if (choice.type === "function") {
    const name = optionalString(asRecord(choice.function).name);
    if (name) {
      return {
        type: "tool" as const,
        toolName: name
      };
    }
  }

  if (
    options.fusionEnabled &&
    (choice.type === "openrouter:fusion" || choice.type === "fusion:fusion")
  ) {
    return {
      type: "tool" as const,
      toolName: "fusionTool"
    };
  }

  return "auto" as const;
}

function normalizeClientToolCalls(
  result: unknown,
  clientTools: OpenAIClientFunctionTool[] | undefined
): OpenAIClientToolCall[] {
  const allowed = new Set(clientTools?.map((entry) => entry.function.name) ?? []);
  if (allowed.size === 0) {
    return [];
  }

  return toolCallsFrom(result).flatMap((toolCall): OpenAIClientToolCall[] => {
    const call = asRecord(toolCall);
    const toolName = optionalString(call.toolName);
    if (!toolName || !allowed.has(toolName)) {
      return [];
    }

    const input = call.input ?? call.args ?? {};
    const id =
      optionalString(call.toolCallId) ?? optionalString(call.id) ?? shortId("call");

    return [
      {
        id,
        type: "function",
        function: {
          name: toolName,
          arguments: JSON.stringify(input ?? {})
        }
      }
    ];
  });
}

function forcedClientToolName(toolChoice: unknown) {
  const choice = asRecord(toolChoice);
  if (choice.type !== "function") {
    return undefined;
  }
  return optionalString(asRecord(choice.function).name);
}

function clientToolChoiceRequiresCall(toolChoice: unknown) {
  return toolChoice === "required" || Boolean(forcedClientToolName(toolChoice));
}

function clientToolChoiceDisablesCalls(toolChoice: unknown) {
  return toolChoice === "none";
}

export function harnessClientToolInstruction(
  clientTools: OpenAIClientFunctionTool[] | undefined,
  clientToolChoice: unknown
) {
  if (!clientTools?.length || clientToolChoiceDisablesCalls(clientToolChoice)) {
    return undefined;
  }

  const forcedName = forcedClientToolName(clientToolChoice);
  const allowedTools = forcedName
    ? clientTools.filter((entry) => entry.function.name === forcedName)
    : clientTools;
  if (allowedTools.length === 0) {
    return undefined;
  }

  const requirement = forcedName
    ? `The client explicitly selected the "${forcedName}" tool. If a response is possible, return that tool call.`
    : clientToolChoice === "required"
      ? "The client requires one tool call. Return one of the allowed tool calls."
      : "If you need client workspace access, return one tool call. Otherwise answer normally.";

  return [
    "Client tools are available, but this local harness can only pass them back to the calling client.",
    requirement,
    "To call a tool, return ONLY this JSON object and no prose:",
    '{"tool_call":{"name":"tool_name","arguments":{}}}',
    "Allowed tools:",
    JSON.stringify(
      allowedTools.map((entry) => ({
        name: entry.function.name,
        description: entry.function.description ?? "",
        parameters: entry.function.parameters ?? { type: "object", properties: {} }
      }))
    )
  ].join("\n");
}

function tryParseJsonObjectFromText(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : trimmed).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(body.slice(start, end + 1)) as unknown;
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

function asToolCallRecords(value: unknown): Record<string, unknown>[] {
  const root = asRecord(value);
  const toolCalls = root.tool_calls;
  if (Array.isArray(toolCalls)) {
    return toolCalls.map(asRecord);
  }

  const toolCall = root.tool_call;
  if (toolCall && typeof toolCall === "object" && !Array.isArray(toolCall)) {
    return [asRecord(toolCall)];
  }

  return [];
}

export function parseHarnessClientToolCalls(
  text: string,
  clientTools: OpenAIClientFunctionTool[] | undefined,
  clientToolChoice: unknown
): OpenAIClientToolCall[] {
  if (!clientTools?.length || clientToolChoiceDisablesCalls(clientToolChoice)) {
    return [];
  }

  const allowed = new Set(clientTools.map((entry) => entry.function.name));
  const forcedName = forcedClientToolName(clientToolChoice);
  const parsed = tryParseJsonObjectFromText(text);
  if (!parsed) {
    return [];
  }

  return asToolCallRecords(parsed).flatMap((call): OpenAIClientToolCall[] => {
    const name = optionalString(call.name);
    if (!name || !allowed.has(name) || (forcedName && name !== forcedName)) {
      return [];
    }

    const args = call.arguments ?? call.input ?? call.args ?? {};
    return [
      {
        id: optionalString(call.id) ?? shortId("call"),
        type: "function",
        function: {
          name,
          arguments: typeof args === "string" ? args : JSON.stringify(args ?? {})
        }
      }
    ];
  });
}

// ── Local harness execution ─────────────────────────────────────────────────

function assertHarnessRunnable(harness: HarnessProviderId) {
  const provider = harnessProviders().find((entry) => entry.id === harness);
  if (!provider || provider.status !== "ready") {
    throw new FusionConfigurationError(
      provider
        ? `${provider.label} local harness is not runnable: ${provider.reason}`
        : `Unknown local harness "${harness}".`
    );
  }
}

/**
 * Assert every backend a model set depends on is available: hosted credentials
 * for hosted models, an enabled + installed CLI for harness models. This lets a
 * harness-only fusion run without hosted API keys, and a hosted-only fusion run
 * without any local CLI.
 */
export function assertBackendsAvailable(models: Array<string | undefined>) {
  const backends = requiredBackends(models);
  if (backends.gateway) {
    assertRuntimeCredentials();
  }
  if (backends.openrouter) {
    assertOpenRouterCredentials();
  }
  for (const harness of backends.harnesses) {
    assertHarnessRunnable(harness);
  }
}

/**
 * Per-provider thinking budget for Google models. Gemini reasons by default, so
 * the budget acts as a ceiling: a smaller effort caps thinking tokens, and `-1`
 * lets the model think as much as the task needs. Values verified against the
 * live Vercel AI Gateway (a 2048 budget measurably shrinks the thinking token count).
 */
const GOOGLE_THINKING_BUDGET: Record<EffortLevel, number> = {
  minimal: 512,
  low: 2048,
  medium: 4096,
  high: 8192,
  max: -1
};

/**
 * Map a node's effort to the correct reasoning control for its provider, routed
 * through the Vercel AI Gateway's `providerOptions` pass-through. Each shape is
 * verified against the live Vercel AI Gateway, because the providers diverge:
 *   - OpenAI takes `reasoningEffort` (+ `reasoningSummary`, required to surface
 *     any reasoning output); it tops out at "high".
 *   - Current Anthropic models (opus-4.8) use adaptive thinking — the model
 *     self-regulates depth. The older `thinking.type:"enabled"` + `budgetTokens`
 *     form is rejected by these models, so there is no token-budget knob; "minimal"
 *     keeps the fast no-thinking path.
 *   - Google takes an explicit thinking-token budget (see GOOGLE_THINKING_BUDGET).
 * Without an effort set this returns undefined, so runs are byte-for-byte unchanged.
 */
function gatewayProviderOptions(
  model: string,
  effort?: EffortLevel
): SharedV3ProviderOptions | undefined {
  if (!effort) {
    return undefined;
  }
  if (model.startsWith("openai/")) {
    const reasoningEffort = effort === "max" ? "high" : effort;
    return { openai: { reasoningEffort, reasoningSummary: "auto" } };
  }
  if (model.startsWith("anthropic/")) {
    if (effort === "minimal") {
      return undefined;
    }
    return { anthropic: { thinking: { type: "adaptive" } } };
  }
  if (model.startsWith("google/")) {
    return { google: { thinkingConfig: { thinkingBudget: GOOGLE_THINKING_BUDGET[effort] } } };
  }
  return undefined;
}

function openRouterProviderOptions(effort?: EffortLevel): SharedV3ProviderOptions | undefined {
  const openrouter: Record<string, unknown> = {};
  if (effort) {
    if (effort === "minimal") {
      openrouter.reasoning = { effort: "minimal" };
    } else {
      openrouter.reasoning = { effort: effort === "max" ? "xhigh" : effort };
    }
  }

  return Object.keys(openrouter).length > 0
    ? ({ openrouter } as SharedV3ProviderOptions)
    : undefined;
}

async function panelViaHarness(
  target: Extract<ModelTarget, { kind: "harness" }>,
  options: ModelCallOptions
): Promise<PanelResponse> {
  const { runHarnessText, harnessProviderMetadata } = await import("./harness-run.ts");
  const result = await runHarnessText({
    harness: target.harness,
    model: target.model,
    prompt: options.prompt,
    system: options.system,
    webEnabled: options.webEnabled,
    effort: options.effort,
    signal: options.signal
  });
  return {
    model: options.model,
    role: options.role,
    content: result.text.trim() || "(The local harness returned no text.)",
    usage: result.usage,
    sources: [],
    latency_ms: result.latency_ms,
    provider_metadata: harnessProviderMetadata(options.model, result)
  };
}

const HARNESS_JUDGE_JSON_INSTRUCTION = [
  "Return ONLY a single JSON object, no prose and no markdown fences, with exactly these keys:",
  '{"consensus": string[], "contradictions": [{"topic": string, "stances": [{"model": string, "stance": string}]}], "partial_coverage": [{"models": string[], "point": string}], "unique_insights": [{"model": string, "insight": string}], "blind_spots": string[]}',
  "Every array may be empty, but every key must be present."
].join("\n");

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : trimmed).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("The local harness judge did not return a JSON object.");
  }
  return JSON.parse(body.slice(start, end + 1));
}

function parseHarnessAnalysis(text: string): FusionAnalysis {
  return AnalysisSchema.parse(extractJsonObject(text));
}

async function judgeViaHarness(
  target: Extract<ModelTarget, { kind: "harness" }>,
  model: string,
  prompt: string,
  webEnabled: boolean,
  effort?: EffortLevel,
  signal?: AbortSignal
) {
  const { runHarnessText, harnessProviderMetadata } = await import("./harness-run.ts");
  const result = await runHarnessText({
    harness: target.harness,
    model: target.model,
    prompt: `${prompt}\n\n${HARNESS_JUDGE_JSON_INSTRUCTION}`,
    webEnabled,
    effort,
    signal
  });
  return {
    analysis: parseHarnessAnalysis(result.text),
    latency_ms: result.latency_ms,
    sources: [] as SourceRecord[],
    usage: result.usage,
    provider_metadata: harnessProviderMetadata(model, result)
  };
}

async function synthViaHarness(
  target: Extract<ModelTarget, { kind: "harness" }>,
  model: string,
  prompt: string,
  webEnabled: boolean,
  effort?: EffortLevel,
  signal?: AbortSignal
) {
  const { runHarnessText, harnessProviderMetadata } = await import("./harness-run.ts");
  const result = await runHarnessText({
    harness: target.harness,
    model: target.model,
    prompt,
    webEnabled,
    effort,
    signal
  });
  return {
    text: result.text.trim() || "(The local harness returned no text.)",
    usage: result.usage,
    latency_ms: result.latency_ms,
    sources: [] as SourceRecord[],
    provider_metadata: harnessProviderMetadata(model, result)
  };
}

function buildHarnessOuterPrompt(prompt: string, fusion: FusionResult): string {
  const lines = [
    "You are the final author of a multi-model fusion. Write the best possible answer to the user's request, grounded in the panel analysis below. Do not mention the fusion or expose hidden reasoning.",
    "",
    `User request:\n${prompt}`,
    ""
  ];
  if (fusion.analysis) {
    lines.push(`Judge analysis (JSON):\n${JSON.stringify(fusion.analysis)}`, "");
  }
  if (fusion.responses.length > 0) {
    lines.push("Panel responses:");
    for (const response of fusion.responses) {
      lines.push(`## ${response.model} (${response.role})`, response.content, "");
    }
  }
  return lines.join("\n");
}

async function outerViaHarness(
  target: Extract<ModelTarget, { kind: "harness" }>,
  options: Parameters<typeof callOuterModelWithFusionTool>[0]
): Promise<Awaited<ReturnType<typeof callOuterModelWithFusionTool>>> {
  const { runHarnessText, harnessProviderMetadata } = await import("./harness-run.ts");
  const fusionEnabled = options.fusionEnabled !== false;
  let fusionResult: FusionResult | undefined;
  let prompt = options.prompt;
  let system: string | undefined = options.system;
  if (fusionEnabled) {
    fusionResult = await options.executeFusion(options.prompt);
    prompt = buildHarnessOuterPrompt(options.prompt, fusionResult);
    system = undefined;
  }
  const toolInstruction = harnessClientToolInstruction(
    options.clientTools,
    options.clientToolChoice
  );
  if (toolInstruction) {
    prompt = `${prompt}\n\n${toolInstruction}`;
  }
  const result = await runHarnessText({
    harness: target.harness,
    model: target.model,
    prompt,
    system,
    webEnabled: false,
    effort: options.effort,
    signal: options.signal
  });
  const clientToolCalls = parseHarnessClientToolCalls(
    result.text,
    options.clientTools,
    options.clientToolChoice
  );
  if (clientToolChoiceRequiresCall(options.clientToolChoice) && clientToolCalls.length === 0) {
    throw new FusionConfigurationError(
      "The local harness synthesizer did not return the required client tool call. Use a Vercel AI Gateway/OpenRouter synthesizer for native tool calling, or set tool_choice to auto/none."
    );
  }
  return {
    text: clientToolCalls.length > 0
      ? ""
      : result.text.trim() || "(The local harness returned no text.)",
    usage: result.usage,
    latency_ms: result.latency_ms,
    sources: [],
    provider_metadata: harnessProviderMetadata(options.outerModel, result),
    fusion_result: fusionResult,
    client_tool_calls: clientToolCalls
  };
}

export async function callPanelModel(
  options: ModelCallOptions
): Promise<PanelResponse> {
  const target = resolveModelTarget(options.model);
  if (target.kind === "harness") {
    return panelViaHarness(target, options);
  }

  const started = Date.now();
  assertHostedCredentials(target);

  const tools = await toolsFor(
    options.model,
    options.webEnabled,
    options.localToolsEnabled,
    {
      search: options.webSearch,
      fetch: options.webFetch
    }
  );

  const shared = {
    model: hostedModel(target),
    system: options.system,
    prompt: options.prompt,
    temperature: options.temperature ?? 0.2,
    topP: options.topP,
    presencePenalty: options.presencePenalty,
    frequencyPenalty: options.frequencyPenalty,
    seed: options.seed,
    stopSequences: options.stopSequences,
    maxOutputTokens: options.maxOutputTokens,
    providerOptions: hostedProviderOptions(target, options.effort, {
      enabled: options.webEnabled,
      search: options.webSearch,
      fetch: options.webFetch
    }),
    tools,
    toolChoice: hostedToolChoice(target, tools),
    stopWhen: stepCountIs(Math.max(1, options.maxToolCalls)),
    onStepFinish: toolStepReporter(options.onTool),
    abortSignal: options.signal
  };

  // Stream the panel's tokens when a sink is provided (the studio activity log),
  // so each model is seen typing live. The resolved result still feeds the exact
  // same source/usage/metadata helpers as the non-streaming path.
  if (options.onDelta) {
    const stream = streamText(shared);
    for await (const delta of stream.textStream) {
      if (delta) options.onDelta(delta);
    }
    const [text, usage, sourcesRaw, steps, providerMetadata, response] = await Promise.all([
      stream.text,
      stream.usage,
      stream.sources,
      stream.steps,
      stream.providerMetadata,
      stream.response
    ]);
    const resolved = { text, usage, sources: sourcesRaw, steps, providerMetadata, response };
    const sources = normalizeSources(resolved);
    return {
      model: options.model,
      role: options.role,
      content: text.trim() || summarizeSources(sources),
      usage: normalizeUsage(usage),
      sources,
      latency_ms: Date.now() - started,
      provider_metadata: await providerMetadataForResult(resolved, options.model, target)
    };
  }

  const result = await generateText(shared);
  const sources = normalizeSources(result);
  const providerMetadata = await providerMetadataForResult(result, options.model, target);

  return {
    model: options.model,
    role: options.role,
    content: result.text.trim() || summarizeSources(sources),
    usage: normalizeUsage(result.usage),
    sources,
    latency_ms: Date.now() - started,
    provider_metadata: providerMetadata
  };
}

export async function callJudge(
  model: string,
  prompt: string,
  options: {
    webEnabled: boolean;
    localToolsEnabled: boolean;
    webSearch?: WebSearchConfig;
    webFetch?: WebFetchConfig;
    maxToolCalls: number;
    temperature?: number;
    topP?: number;
    presencePenalty?: number;
    frequencyPenalty?: number;
    seed?: number;
    stopSequences?: string[];
    maxOutputTokens?: number;
    effort?: EffortLevel;
    onTool?: (report: NodeToolReport) => void;
    signal?: AbortSignal;
  }
): Promise<{
  analysis: FusionAnalysis;
  latency_ms: number;
  sources: SourceRecord[];
  usage: UsageRecord;
  provider_metadata?: ProviderCallMetadata;
}> {
  const target = resolveModelTarget(model);
  if (target.kind === "harness") {
    return judgeViaHarness(target, model, prompt, options.webEnabled, options.effort, options.signal);
  }

  const started = Date.now();
  assertHostedCredentials(target);
  const tools = await toolsFor(model, options.webEnabled, options.localToolsEnabled, {
    search: options.webSearch,
    fetch: options.webFetch
  });

  const result = await generateText({
    model: hostedModel(target),
    prompt,
    temperature: 0,
    maxOutputTokens: options.maxOutputTokens,
    providerOptions: hostedProviderOptions(target, options.effort, {
      enabled: options.webEnabled,
      search: options.webSearch,
      fetch: options.webFetch
    }),
    tools,
    toolChoice: hostedToolChoice(target, tools),
    stopWhen: stepCountIs(Math.max(2, options.maxToolCalls + 1)),
    onStepFinish: toolStepReporter(options.onTool),
    abortSignal: options.signal,
    output: Output.object({
      schema: AnalysisSchema as z.ZodType<FusionAnalysis>
    })
  });

  return {
    analysis: result.output,
    latency_ms: Date.now() - started,
    sources: normalizeSources(result),
    usage: normalizeUsage(result.usage),
    provider_metadata: await providerMetadataForResult(result, model, target)
  };
}

export async function callSynthesis(
  model: string,
  prompt: string,
  options: {
    webEnabled: boolean;
    localToolsEnabled: boolean;
    webSearch?: WebSearchConfig;
    webFetch?: WebFetchConfig;
    maxToolCalls: number;
    temperature?: number;
    topP?: number;
    presencePenalty?: number;
    frequencyPenalty?: number;
    seed?: number;
    stopSequences?: string[];
    maxOutputTokens?: number;
    effort?: EffortLevel;
    /** Called per text delta to stream the final answer to the client live. */
    onToken?: (delta: string) => void;
    onTool?: (report: NodeToolReport) => void;
    signal?: AbortSignal;
  }
): Promise<{
  text: string;
  usage: UsageRecord;
  latency_ms: number;
  sources: SourceRecord[];
  provider_metadata?: ProviderCallMetadata;
}> {
  const target = resolveModelTarget(model);
  if (target.kind === "harness") {
    // Harness CLIs return the whole message at once in read-only print mode, so
    // there are no tokens to stream — the caller falls back to a single chunk.
    return synthViaHarness(target, model, prompt, options.webEnabled, options.effort, options.signal);
  }

  const started = Date.now();
  assertHostedCredentials(target);
  const tools = await toolsFor(model, options.webEnabled, options.localToolsEnabled, {
    search: options.webSearch,
    fetch: options.webFetch
  });

  // Stream the synthesizer's tokens to the client when a sink is provided (the
  // OpenAI streaming endpoint). The resolved result still feeds the exact same
  // source/usage/metadata helpers as the non-streaming path.
  if (options.onToken) {
    const stream = streamText({
      model: hostedModel(target),
      prompt,
      temperature: options.temperature ?? 0.2,
      topP: options.topP,
      presencePenalty: options.presencePenalty,
      frequencyPenalty: options.frequencyPenalty,
      seed: options.seed,
      stopSequences: options.stopSequences,
      maxOutputTokens: options.maxOutputTokens,
      providerOptions: hostedProviderOptions(target, options.effort, {
        enabled: options.webEnabled,
        search: options.webSearch,
        fetch: options.webFetch
      }),
      tools,
      toolChoice: hostedToolChoice(target, tools),
      stopWhen: stepCountIs(Math.max(1, options.maxToolCalls)),
      onStepFinish: toolStepReporter(options.onTool),
      abortSignal: options.signal
    });
    for await (const delta of stream.textStream) {
      if (delta) options.onToken(delta);
    }
    const [text, usage, sourcesRaw, steps, providerMetadata, response] = await Promise.all([
      stream.text,
      stream.usage,
      stream.sources,
      stream.steps,
      stream.providerMetadata,
      stream.response
    ]);
    const resolved = { text, usage, sources: sourcesRaw, steps, providerMetadata, response };
    const sources = normalizeSources(resolved);
    return {
      text: text.trim() || summarizeSources(sources),
      usage: normalizeUsage(usage),
      latency_ms: Date.now() - started,
      sources,
      provider_metadata: await providerMetadataForResult(resolved, model, target)
    };
  }

  const result = await generateText({
    model: hostedModel(target),
    prompt,
    temperature: options.temperature ?? 0.2,
    topP: options.topP,
    presencePenalty: options.presencePenalty,
    frequencyPenalty: options.frequencyPenalty,
    seed: options.seed,
    stopSequences: options.stopSequences,
    maxOutputTokens: options.maxOutputTokens,
    providerOptions: hostedProviderOptions(target, options.effort, {
      enabled: options.webEnabled,
      search: options.webSearch,
      fetch: options.webFetch
    }),
    tools,
    toolChoice: hostedToolChoice(target, tools),
    stopWhen: stepCountIs(Math.max(1, options.maxToolCalls)),
    onStepFinish: toolStepReporter(options.onTool),
    abortSignal: options.signal
  });
  const sources = normalizeSources(result);

  return {
    text: result.text.trim() || summarizeSources(sources),
    usage: normalizeUsage(result.usage),
    latency_ms: Date.now() - started,
    sources,
    provider_metadata: await providerMetadataForResult(result, model, target)
  };
}

export async function callOuterModelWithFusionTool(options: {
  outerModel: string;
  prompt: string;
  system: string;
  forceFusion: boolean;
  temperature?: number;
  topP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  stopSequences?: string[];
  maxOutputTokens?: number;
  fusionEnabled?: boolean;
  clientTools?: OpenAIClientFunctionTool[];
  clientToolChoice?: unknown;
  executeFusion: (prompt: string) => Promise<FusionResult>;
  effort?: EffortLevel;
  /** Called per text delta to stream the final answer to the client live. */
  onToken?: (delta: string) => void;
  /** Aborts the upstream call when the client stops or disconnects. */
  signal?: AbortSignal;
}): Promise<{
  text: string;
  usage: UsageRecord;
  latency_ms: number;
  sources: SourceRecord[];
  provider_metadata?: ProviderCallMetadata;
  fusion_result?: FusionResult;
  client_tool_calls: OpenAIClientToolCall[];
}> {
  const outerTarget = resolveModelTarget(options.outerModel);
  if (outerTarget.kind === "harness") {
    return outerViaHarness(outerTarget, options);
  }

  const started = Date.now();
  assertHostedCredentials(outerTarget);
  let fusionResult: FusionResult | undefined;
  const clientTools = aiSdkClientTools(options.clientTools);
  const fusionEnabled = options.fusionEnabled !== false;
  const fusionTools: ToolSet = fusionEnabled
    ? {
        fusionTool: tool({
          description:
            "Run the Fusion workflow for prompts that benefit from multiple model perspectives, fresh evidence, expert critique, or high-cost-of-error analysis. This is the local OpenRouter-compatible fusion server tool.",
          inputSchema: z.object({
            prompt: z
              .string()
              .min(1)
              .optional()
              .describe("Optional focused prompt for the Fusion panel. Defaults to the user's current request.")
          }),
          execute: async ({ prompt }) => {
            const nextFusionResult = await options.executeFusion(
              prompt?.trim() || options.prompt
            );
            if (
              !fusionResult ||
              nextFusionResult.failure_reason !== "fusion_invocation_capped"
            ) {
              fusionResult = nextFusionResult;
            }

            return {
              object: nextFusionResult.object,
              status: nextFusionResult.status,
              degraded: nextFusionResult.degraded,
              failure_reason: nextFusionResult.failure_reason,
              analysis: nextFusionResult.analysis,
              responses: nextFusionResult.responses.map((response) => ({
                model: response.model,
                role: response.role,
                content: response.content,
                sources: response.sources
              })),
              failed_models: nextFusionResult.failed_models,
              sources: nextFusionResult.sources,
              usage: nextFusionResult.usage,
              latency_ms: nextFusionResult.latency_ms,
              cost_usd: nextFusionResult.cost_usd
            };
          }
        })
      }
    : {};
  const modelTools: ToolSet = {
    ...fusionTools,
    ...clientTools
  };
  const hasTools = Object.keys(modelTools).length > 0;
  const toolChoice = hasTools
    ? aiSdkToolChoice({
        forceFusion: options.forceFusion,
        fusionEnabled,
        clientToolChoice: options.clientToolChoice
      })
    : undefined;

  // Stream the final answer when the client is streaming. The fusion tool still
  // runs inside the stream (its `execute` closure captures `fusionResult`), and
  // the resolved result feeds the exact same source/tool-call/metadata helpers as
  // the non-streaming path. When the model emits client tool calls instead of an
  // answer, no text streams and the caller emits the tool calls as usual.
  if (options.onToken) {
    const stream = streamText({
      model: hostedModel(outerTarget),
      system: options.system,
      prompt: options.prompt,
      temperature: options.temperature ?? 0.2,
      topP: options.topP,
      presencePenalty: options.presencePenalty,
      frequencyPenalty: options.frequencyPenalty,
      seed: options.seed,
      stopSequences: options.stopSequences,
      maxOutputTokens: options.maxOutputTokens,
      providerOptions: hostedProviderOptions(outerTarget, options.effort),
      tools: hasTools ? modelTools : undefined,
      toolChoice,
      stopWhen: stepCountIs(2),
      abortSignal: options.signal
    });
    for await (const delta of stream.textStream) {
      if (delta) options.onToken(delta);
    }
    const [text, usage, sourcesRaw, steps, toolCalls, providerMetadata, response] =
      await Promise.all([
        stream.text,
        stream.usage,
        stream.sources,
        stream.steps,
        stream.toolCalls,
        stream.providerMetadata,
        stream.response
      ]);
    const resolved = { text, usage, sources: sourcesRaw, steps, toolCalls, providerMetadata, response };
    const sources = normalizeSources(resolved);
    return {
      text: text.trim() || summarizeSources(sources),
      usage: normalizeUsage(usage),
      sources,
      latency_ms: Date.now() - started,
      provider_metadata: await providerMetadataForResult(resolved, options.outerModel, outerTarget),
      fusion_result: fusionResult,
      client_tool_calls: normalizeClientToolCalls(resolved, options.clientTools)
    };
  }

  const result = await generateText({
    model: hostedModel(outerTarget),
    system: options.system,
    prompt: options.prompt,
    temperature: options.temperature ?? 0.2,
    topP: options.topP,
    presencePenalty: options.presencePenalty,
    frequencyPenalty: options.frequencyPenalty,
    seed: options.seed,
    stopSequences: options.stopSequences,
    maxOutputTokens: options.maxOutputTokens,
    providerOptions: hostedProviderOptions(outerTarget, options.effort),
    tools: hasTools ? modelTools : undefined,
    toolChoice,
    stopWhen: stepCountIs(2),
    abortSignal: options.signal
  });

  const sources = normalizeSources(result);
  const clientToolCalls = normalizeClientToolCalls(result, options.clientTools);

  return {
    text: result.text.trim() || summarizeSources(sources),
    usage: normalizeUsage(result.usage),
    sources,
    latency_ms: Date.now() - started,
    provider_metadata: await providerMetadataForResult(result, options.outerModel, outerTarget),
    fusion_result: fusionResult,
    client_tool_calls: clientToolCalls
  };
}
