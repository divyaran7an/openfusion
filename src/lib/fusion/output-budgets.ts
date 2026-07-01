import type { RunRequest } from "./schemas.ts";

export function outputBudgetsForRequest(
  request: Pick<RunRequest, "fusion" | "max_completion_tokens" | "max_tokens">
) {
  return {
    // OpenRouter Fusion's max_completion_tokens is for inner panel/judge calls.
    // It prevents reasoning-heavy inner calls from spending their whole budget
    // before visible analysis is produced.
    inner: request.fusion?.max_completion_tokens,
    // OpenAI-compatible client caps apply to the final user-visible response.
    final: request.max_completion_tokens ?? request.max_tokens
  };
}
