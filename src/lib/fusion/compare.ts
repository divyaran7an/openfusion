import { z } from "zod";

export const CompareTargetSchema = z.enum(["quality", "value", "speed"]);
export type CompareTarget = "quality" | "value" | "speed";

export const CouncilRunRecordSchema = z.object({
  councilId: z.string().min(1),
  councilName: z.string().min(1),
  isTeacher: z.boolean().optional(),
  runId: z.string().min(1).optional(),
  answer: z.string().optional(),
  status: z.enum(["ok", "error"]).optional(),
  score: z
    .object({
      overall: z.number().min(0).max(100).optional(),
      rationale: z.string().optional(),
      missed_vs_teacher: z.string().optional()
    })
    .optional(),
  metrics: z
    .object({
      latencyMs: z.number().nonnegative().optional(),
      cost: z.number().nonnegative().optional(),
      tokens: z.number().int().nonnegative().optional()
    })
    .optional()
});

export type CouncilRun = {
  councilId: string;
  councilName: string;
  isTeacher?: boolean;
  runId?: string;
  answer?: string;
  status?: "ok" | "error";
  score?: {
    overall?: number;
    rationale?: string;
    missed_vs_teacher?: string;
  };
  metrics?: {
    latencyMs?: number;
    cost?: number;
    tokens?: number;
  };
};

function qualityScore(run: CouncilRun) {
  return typeof run.score?.overall === "number" ? run.score.overall : undefined;
}

function targetScore(run: CouncilRun, target: CompareTarget): number | undefined {
  const score = qualityScore(run);
  if (score == null) return undefined;

  if (target === "quality") return score;

  if (target === "value") {
    const cost = run.metrics?.cost;
    return typeof cost === "number" && cost > 0 ? score / cost : undefined;
  }

  const latencyMs = run.metrics?.latencyMs;
  return typeof latencyMs === "number" && latencyMs > 0 ? score / (latencyMs / 1000) : undefined;
}

function compareByScoreThenId(
  left: CouncilRun,
  right: CouncilRun,
  scoreFor: (run: CouncilRun) => number | undefined
) {
  const leftScore = scoreFor(left);
  const rightScore = scoreFor(right);
  const leftKnown = typeof leftScore === "number";
  const rightKnown = typeof rightScore === "number";

  if (leftKnown && rightKnown && leftScore !== rightScore) {
    return rightScore - leftScore;
  }
  if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
  return left.councilId.localeCompare(right.councilId);
}

export function rankRuns(runs: CouncilRun[], target: CompareTarget): CouncilRun[] {
  const candidates = runs.filter((run) => !run.isTeacher);
  if (candidates.length === 0) return [];

  if (target === "quality") {
    return [...candidates].sort((left, right) =>
      compareByScoreThenId(left, right, qualityScore)
    );
  }

  const eligible = candidates.filter((run) => targetScore(run, target) != null);
  if (eligible.length === 0) {
    return [...candidates].sort((left, right) =>
      compareByScoreThenId(left, right, qualityScore)
    );
  }

  return eligible.sort((left, right) =>
    compareByScoreThenId(left, right, (run) => targetScore(run, target))
  );
}
