import type { FusionRun } from "./types";

/** Index stored client tool calls into OpenAI streaming `tool_calls` deltas. */
export function toolCallDeltas(
  toolCalls: NonNullable<FusionRun["metadata"]["client_tool_calls"]>
) {
  return toolCalls.map((toolCall, index) => ({
    index,
    ...toolCall
  }));
}

export function openAICompletionFromRun(run: FusionRun, model: string) {
  const toolCalls = run.metadata.client_tool_calls;
  const finishReason = toolCalls?.length
    ? "tool_calls"
    : run.status === "ok"
      ? "stop"
      : "error";

  return {
    id: `chatcmpl_${run.id.replace(/^run_/, "")}`,
    object: "chat.completion",
    created: Math.floor(new Date(run.created_at).getTime() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: toolCalls?.length ? null : run.final,
          ...(toolCalls?.length ? { tool_calls: toolCalls } : {})
        },
        finish_reason: finishReason
      }
    ],
    usage: {
      prompt_tokens: run.usage.input_tokens,
      completion_tokens: run.usage.output_tokens,
      total_tokens: run.usage.total_tokens
    },
    fusion: {
      run_id: run.id,
      status: run.status,
      degraded: run.degraded,
      mode: run.mode,
      trace_id: run.metadata.trace_id,
      panel_size: run.metadata.panel_size,
      cost_usd: run.cost_usd,
      cost_source: run.metadata.cost_source,
      cost_coverage: run.metadata.cost_coverage,
      client_tool_calls: toolCalls,
      latency_ms: run.latency_ms,
      provider_generations: run.metadata.provider_generations
    }
  };
}

export function streamOpenAICompletion(run: FusionRun, model: string) {
  const encoder = new TextEncoder();
  const created = Math.floor(new Date(run.created_at).getTime() / 1000);
  const id = `chatcmpl_${run.id.replace(/^run_/, "")}`;
  const toolCalls = run.metadata.client_tool_calls;

  const chunk = (
    delta: Record<string, unknown>,
    finishReason: string | null = null
  ) =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason
        }
      ],
      fusion: {
        run_id: run.id,
        status: run.status,
        degraded: run.degraded,
        mode: run.mode,
        trace_id: run.metadata.trace_id,
        panel_size: run.metadata.panel_size,
        cost_usd: run.cost_usd,
        cost_source: run.metadata.cost_source,
        cost_coverage: run.metadata.cost_coverage,
        client_tool_calls: toolCalls,
        latency_ms: run.latency_ms,
        provider_generations: run.metadata.provider_generations
      }
    })}\n\n`;

  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: { role: "assistant" },
                finish_reason: null
              }
            ]
          })}\n\n`
        )
      );
      if (toolCalls?.length) {
        controller.enqueue(
          encoder.encode(chunk({ tool_calls: toolCallDeltas(toolCalls) }))
        );
        controller.enqueue(encoder.encode(chunk({}, "tool_calls")));
      } else {
        controller.enqueue(encoder.encode(chunk({ content: run.final })));
        controller.enqueue(encoder.encode(chunk({}, run.status === "ok" ? "stop" : "error")));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
}
