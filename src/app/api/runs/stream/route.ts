import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/fusion/auth";
import { FusionConfigurationError } from "@/lib/fusion/errors";
import { runFusion } from "@/lib/fusion/orchestrator";
import {
  completeRunEvents,
  failRunEvents,
  publishRunEvent
} from "@/lib/fusion/run-event-bus";
import { RunRequestSchema } from "@/lib/fusion/schemas";
import { saveRun, saveRunEvents } from "@/lib/fusion/store";
import type { FusionRunEvent } from "@/lib/fusion/types";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  const authError = requireApiAuth(request);
  if (authError) {
    return authError;
  }

  try {
    const input = RunRequestSchema.parse(await request.json());

    return new Response(streamRun(input), {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive"
      }
    });
  } catch (error) {
    return errorResponse(error);
  }
}

function streamRun(input: ReturnType<typeof RunRequestSchema.parse>) {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      const events: FusionRunEvent[] = [];

      function send(event: string, data: unknown, id?: string | number) {
        if (id !== undefined) {
          controller.enqueue(encoder.encode(`id: ${id}\n`));
        }
        controller.enqueue(encoder.encode(`event: ${event}\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      }

      try {
        send("stream.started", {
          object: "fusion.run.stream",
          status: "accepted",
          created_at: new Date().toISOString()
        });

        const run = await runFusion(input, {
          onEvent: (event) => {
            events.push(event);
            publishRunEvent(event);
            send(event.type, event, event.sequence);
          }
        });

        await saveRun(run);
        await saveRunEvents(run.id, events);
        completeRunEvents(run.id);

        send("run.saved", {
          object: "fusion.run.saved",
          run_id: run.id,
          event_count: events.length
        });
        send("run.final", run);
        send("done", "[DONE]");
      } catch (error) {
        failRunEvents(events[0]?.run_id, error);
        send("run.error", {
          object: "fusion.run.error",
          error: {
            type:
              error instanceof FusionConfigurationError
                ? "configuration_required"
                : "unexpected_error",
            message:
              error instanceof Error
                ? error.message
                : "Unexpected Fusion stream failure."
          }
        });
        send("done", "[DONE]");
      } finally {
        controller.close();
      }
    }
  });
}

function errorResponse(error: unknown) {
  if (error instanceof FusionConfigurationError) {
    return NextResponse.json(
      {
        error: {
          type: "configuration_required",
          message: error.message
        }
      },
      { status: 503 }
    );
  }

  if (error instanceof Error) {
    return NextResponse.json(
      {
        error: {
          type: "bad_request",
          message: error.message
        }
      },
      { status: 400 }
    );
  }

  return NextResponse.json(
    {
      error: {
        type: "unexpected_error",
        message: "Unexpected Fusion stream setup failure."
      }
    },
    { status: 500 }
  );
}
