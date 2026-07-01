import type { FailureReason } from "./schemas";

export class FusionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FusionConfigurationError";
  }
}

function errorRecord(error: unknown) {
  return error && typeof error === "object"
    ? (error as Record<string, unknown>)
    : {};
}

function errorText(error: unknown) {
  const record = errorRecord(error);
  return [
    error instanceof Error ? error.name : undefined,
    error instanceof Error ? error.message : undefined,
    typeof error === "string" ? error : undefined,
    typeof record.code === "string" ? record.code : undefined,
    typeof record.type === "string" ? record.type : undefined,
    typeof record.status === "number" ? String(record.status) : undefined,
    typeof record.statusCode === "number" ? String(record.statusCode) : undefined
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function classifyProviderError(error: unknown): FailureReason {
  const text = errorText(error);

  if (
    /\b(402|payment required)\b/.test(text) ||
    text.includes("insufficient credit") ||
    text.includes("insufficient balance") ||
    text.includes("quota exceeded") ||
    text.includes("billing")
  ) {
    return "insufficient_credits";
  }

  if (
    /\b429\b/.test(text) ||
    text.includes("rate_limit") ||
    text.includes("rate limit") ||
    text.includes("too many requests")
  ) {
    return "rate_limited";
  }

  if (
    text.includes("aborterror") ||
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("etimedout")
  ) {
    return "provider_timeout";
  }

  if (
    text.includes("policy") ||
    text.includes("content_filter") ||
    text.includes("safety") ||
    text.includes("blocked")
  ) {
    return "policy_blocked";
  }

  return "unexpected_error";
}

export function classifyJudgeError(error: unknown): FailureReason {
  const text = errorText(error);

  if (
    text.includes("json") ||
    text.includes("schema") ||
    text.includes("structured") ||
    text.includes("object") ||
    text.includes("parse")
  ) {
    return "invalid_judge_json";
  }

  return classifyProviderError(error);
}
