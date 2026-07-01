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
  model: string
): ProviderCallMetadata | undefined {
  const value = asRecord(result);
  const providerMetadata = asRecord(value.providerMetadata);
  const gatewayMetadata = asRecord(providerMetadata.gateway);
  const response = asRecord(value.response);
  const headers = asRecord(response.headers);
  const metadata: ProviderCallMetadata = {
    model,
    provider: "gateway",
    generation_id: optionalString(gatewayMetadata.generationId),
    request_id: headerValue(headers, [
      "x-request-id",
      "x-vercel-id",
      "ai-o11y-request-id"
    ]),
    response_id: optionalString(response.id),
    response_model: optionalString(response.model),
    timestamp:
      response.timestamp instanceof Date
        ? response.timestamp.toISOString()
        : optionalString(response.timestamp)
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
    timestamp: optionalString(generation.createdAt) ?? metadata.timestamp,
    total_cost_usd: optionalNumber(generation.totalCost),
    upstream_inference_cost_usd: optionalNumber(generation.upstreamInferenceCost),
    usage_cost_usd: optionalNumber(generation.usage),
    provider_name: optionalString(generation.providerName),
    is_byok: optionalBoolean(generation.isByok),
    streamed: optionalBoolean(generation.streamed),
    finish_reason: optionalString(generation.finishReason),
    latency_ms: optionalNumber(generation.latency),
    generation_time_ms: optionalNumber(generation.generationTime),
    prompt_tokens: optionalNumber(generation.promptTokens),
    completion_tokens: optionalNumber(generation.completionTokens),
    reasoning_tokens: optionalNumber(generation.reasoningTokens),
    cached_tokens: optionalNumber(generation.cachedTokens),
    cache_creation_tokens: optionalNumber(generation.cacheCreationTokens),
    billable_web_search_calls: optionalNumber(generation.billableWebSearchCalls)
  };
}
