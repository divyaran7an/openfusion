import type { ProviderCallMetadata } from "./schemas.ts";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function headerValue(headers: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const exact = optionalString(headers[key]);
    if (exact) {
      return exact;
    }

    const lower = key.toLowerCase();
    const found = Object.entries(headers).find(
      ([header]) => header.toLowerCase() === lower
    )?.[1];
    const value = optionalString(found);
    if (value) {
      return value;
    }
  }

  return undefined;
}

export function providerCallMetadata(
  result: unknown,
  model: string,
  provider: "gateway" | "openrouter" = "gateway"
): ProviderCallMetadata | undefined {
  const value = asRecord(result);
  const providerMetadata = asRecord(value.providerMetadata);
  const gatewayMetadata = asRecord(providerMetadata.gateway);
  const openrouterMetadata = asRecord(providerMetadata.openrouter);
  const openrouterUsage = asRecord(openrouterMetadata.usage);
  const openrouterCostDetails = asRecord(openrouterUsage.costDetails);
  const openrouterPromptDetails = asRecord(openrouterUsage.promptTokensDetails);
  const openrouterCompletionDetails = asRecord(openrouterUsage.completionTokensDetails);
  const response = asRecord(value.response);
  const headers = asRecord(response.headers);
  const metadata: ProviderCallMetadata = {
    model,
    provider,
    generation_id:
      optionalString(gatewayMetadata.generationId) ??
      optionalString(openrouterMetadata.generationId) ??
      (provider === "openrouter" ? optionalString(response.id) : undefined),
    request_id: headerValue(headers, [
      "x-request-id",
      "x-vercel-id",
      "ai-o11y-request-id",
      "x-openrouter-request-id"
    ]),
    response_id: optionalString(response.id),
    response_model: optionalString(response.model),
    timestamp:
      response.timestamp instanceof Date
        ? response.timestamp.toISOString()
        : optionalString(response.timestamp),
    ...(provider === "openrouter"
      ? {
          provider_name: optionalString(openrouterMetadata.provider),
          total_cost_usd: optionalNumber(openrouterUsage.cost),
          upstream_inference_cost_usd: optionalNumber(
            openrouterCostDetails.upstreamInferenceCost
          ),
          prompt_tokens: optionalNumber(openrouterUsage.promptTokens),
          completion_tokens: optionalNumber(openrouterUsage.completionTokens),
          reasoning_tokens: optionalNumber(openrouterCompletionDetails.reasoningTokens),
          cached_tokens: optionalNumber(openrouterPromptDetails.cachedTokens)
        }
      : {})
  };

  return Object.entries(metadata).some(
    ([key, entry]) => key !== "model" && key !== "provider" && entry !== undefined
  )
    ? metadata
    : undefined;
}

function optionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

export function enrichProviderCallMetadata(
  metadata: ProviderCallMetadata | undefined,
  generationInfo: unknown
): ProviderCallMetadata | undefined {
  if (!metadata) {
    return undefined;
  }

  const generation = asRecord(generationInfo);

  return {
    ...metadata,
    generation_id: optionalString(generation.id) ?? metadata.generation_id,
    response_model: optionalString(generation.model) ?? metadata.response_model,
    timestamp:
      optionalString(generation.createdAt) ??
      optionalString(generation.created_at) ??
      metadata.timestamp,
    total_cost_usd: optionalNumber(generation.totalCost ?? generation.total_cost),
    upstream_inference_cost_usd: optionalNumber(
      generation.upstreamInferenceCost ?? generation.upstream_inference_cost
    ),
    usage_cost_usd: optionalNumber(generation.usage),
    provider_name: optionalString(generation.providerName ?? generation.provider_name),
    is_byok: optionalBoolean(generation.isByok ?? generation.is_byok),
    streamed: optionalBoolean(generation.streamed),
    finish_reason: optionalString(generation.finishReason ?? generation.finish_reason),
    latency_ms: optionalNumber(generation.latency),
    generation_time_ms: optionalNumber(
      generation.generationTime ?? generation.generation_time
    ),
    prompt_tokens: optionalNumber(generation.promptTokens ?? generation.tokens_prompt),
    completion_tokens: optionalNumber(
      generation.completionTokens ?? generation.tokens_completion
    ),
    reasoning_tokens: optionalNumber(
      generation.reasoningTokens ?? generation.native_tokens_reasoning
    ),
    cached_tokens: optionalNumber(generation.cachedTokens ?? generation.native_tokens_cached),
    cache_creation_tokens: optionalNumber(generation.cacheCreationTokens),
    billable_web_search_calls: optionalNumber(
      generation.billableWebSearchCalls ?? generation.num_search_results
    )
  };
}
