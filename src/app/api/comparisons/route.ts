import { z } from "zod";
import { requireApiAuth } from "@/lib/fusion/auth";
import { rankRuns, CompareTargetSchema, type CouncilRun } from "@/lib/fusion/compare";
import { getCouncil } from "@/lib/fusion/council-store";
import { graphToOverride } from "@/lib/fusion/graph";
import { jsonError } from "@/lib/fusion/http-errors";
import { runFusion } from "@/lib/fusion/orchestrator";
import { listComparisons, saveComparison } from "@/lib/fusion/comparison-store";
import { saveRun, saveRunEvents } from "@/lib/fusion/store";
import type { FusionRunEvent } from "@/lib/fusion/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const CompareCreateSchema = z.object({
  task: z.string().min(1),
  target: CompareTargetSchema.default("value"),
  council_ids: z.array(z.string().min(1)).min(1).max(6),
  teacher_council_id: z.string().min(1).optional()
});

export async function GET(request: Request) {
  const authError = requireApiAuth(request);
  if (authError) return authError;

  return Response.json({
    object: "list",
    data: listComparisons()
  });
}

export async function POST(request: Request) {
  const authError = requireApiAuth(request);
  if (authError) return authError;

  const input = CompareCreateSchema.parse(await request.json());
  const ids = Array.from(new Set([
    ...(input.teacher_council_id ? [input.teacher_council_id] : []),
    ...input.council_ids
  ]));
  const councils = ids.map((id) => getCouncil(id));
  const missing = ids.filter((_, index) => !councils[index]);
  if (missing.length > 0) {
    return jsonError("not_found", `Unknown council id: ${missing.join(", ")}`, 404);
  }

  const comparisonId = `cmp_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const runs: CouncilRun[] = await Promise.all(
    councils.map(async (council) => {
      if (!council) throw new Error("Council disappeared during comparison.");
      const events: FusionRunEvent[] = [];
      try {
        const run = await runFusion(
          {
            prompt: input.task,
            mode: "openfusion",
            fusion: graphToOverride(council.graph),
            metadata: {
              comparison_id: comparisonId,
              council_id: council.id
            }
          },
          {
            onEvent: (event) => {
              events.push(event);
            }
          }
        );
        const saved = await saveRun(run);
        await saveRunEvents(saved.id, events);
        return {
          councilId: council.id,
          councilName: council.name,
          isTeacher: council.id === input.teacher_council_id,
          runId: saved.id,
          answer: saved.final,
          status: saved.status,
          metrics: {
            latencyMs: saved.latency_ms.end_to_end,
            cost: saved.cost_usd,
            tokens: saved.usage.total_tokens
          }
        };
      } catch (error) {
        return {
          councilId: council.id,
          councilName: council.name,
          isTeacher: council.id === input.teacher_council_id,
          answer: error instanceof Error ? error.message : String(error),
          status: "error" as const
        };
      }
    })
  );

  const ranked = rankRuns(runs, input.target);
  const saved = saveComparison({
    id: comparisonId,
    task: input.task,
    target: input.target,
    teacher_council_id: input.teacher_council_id,
    candidate_council_ids: input.council_ids,
    runs
  });

  return Response.json({
    ...saved,
    recommended_council_id: ranked[0]?.councilId
  }, { status: 201 });
}
