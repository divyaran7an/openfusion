import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { FusionBudgetExceededError } from "./errors.ts";
import { isHarnessModel } from "./model-routing.ts";
import type { FusionRun } from "./types.ts";

/**
 * The budget guard: an append-only local spend ledger plus a pre-flight cap.
 *
 * Semantics are deliberately honest: the guard refuses to START a run once the
 * window's recorded hosted spend has reached the cap. A run admitted just
 * under the cap can still overshoot it — post-hoc accounting cannot predict a
 * run's cost — so the cap bounds when spending stops, not the final cent.
 *
 * Only hosted (API-billed) seats count. Claude Code and Codex harness seats
 * bill the user's subscription plan, not per-token dollars, so they are
 * excluded structurally (by model classification, not by happening to report
 * zero cost) and a harness-only council is never refused.
 *
 * The ledger is a JSONL file under `FUSION_DATA_DIR` (default `.fusion/`),
 * like the active graph: durable across restarts with zero external services.
 * Redis-backed run storage is optional; a budget that forgets what it spent on
 * restart would not be a budget.
 */

export const SpendLedgerEntrySchema = z.object({
  object: z.literal("fusion.spend"),
  recorded_at: z.string(),
  run_id: z.string().min(1),
  /** Hosted (API-billed) dollars recorded for this run. */
  amount_usd: z.number().nonnegative(),
  cost_source: z.enum(["estimate", "provider_reported"]),
  coverage_ratio: z.number().min(0).max(1).optional(),
  models: z.array(z.string()),
  hosted_models: z.array(z.string()),
  harness_models: z.array(z.string())
});
export type SpendLedgerEntry = z.infer<typeof SpendLedgerEntrySchema>;

function ledgerPath() {
  const dir = process.env.FUSION_DATA_DIR?.trim() || join(process.cwd(), ".fusion");
  return { dir, file: join(dir, "spend-ledger.jsonl") };
}

const HARNESS_PROVIDERS = new Set(["claude-code", "codex"]);

function isHarnessGeneration(generation: {
  model?: string;
  provider?: string;
}) {
  if (generation.provider && HARNESS_PROVIDERS.has(generation.provider)) {
    return true;
  }
  return Boolean(generation.model && isHarnessModel(generation.model));
}

/**
 * The minimum slice of a run the ledger needs. Accepting the slice (not the
 * full FusionRun) lets the orchestrator record spend for runs that failed
 * after the panel spent money but before a complete run object existed.
 */
export type SpendableRun = Pick<FusionRun, "id" | "cost_usd" | "metadata">;

/**
 * The judge only executes when more than one panel ANSWER exists (not merely
 * more than one configured panel — partial failures skip it), so a judge that
 * never ran must not count as a hosted seat. panel_size rules out the
 * single-panel case; when generation metadata exists, a judge generation is
 * the evidence it actually ran. Without generation metadata the judge is
 * counted — conservative, over-counting rather than under.
 */
function judgeParticipated(metadata: SpendableRun["metadata"]) {
  if (metadata.panel_size <= 1 || !metadata.judge_model) {
    return false;
  }
  const generations = metadata.provider_generations;
  if (!generations || generations.length === 0) {
    return true;
  }
  return generations.some((generation) => generation.model === metadata.judge_model);
}

function runModels(run: SpendableRun): string[] {
  return [
    ...run.metadata.panel_models,
    ...(judgeParticipated(run.metadata) ? [run.metadata.judge_model as string] : []),
    run.metadata.outer_model
  ];
}

/**
 * The hosted (API-billed) spend a run represents. Harness generations are
 * excluded by classification even if they ever reported a nonzero
 * `total_cost_usd`. When no hosted generation came back with a provider price,
 * the run's own `cost_usd` (a token estimate) counts instead — conservative on
 * purpose: an unpriced hosted run still spent money.
 */
export function hostedSpendForRun(run: SpendableRun): {
  amount_usd: number;
  cost_source: "estimate" | "provider_reported";
  hosted_models: string[];
  harness_models: string[];
} {
  const models = runModels(run);
  const hosted_models = models.filter((model) => !isHarnessModel(model));
  const harness_models = models.filter((model) => isHarnessModel(model));

  const pricedHosted = (run.metadata.provider_generations ?? []).filter(
    (generation) =>
      !isHarnessGeneration(generation) &&
      typeof generation.total_cost_usd === "number"
  );

  if (run.metadata.cost_source === "provider_reported" && pricedHosted.length > 0) {
    return {
      amount_usd: pricedHosted.reduce(
        (sum, generation) => sum + (generation.total_cost_usd ?? 0),
        0
      ),
      cost_source: "provider_reported",
      hosted_models,
      harness_models
    };
  }

  return {
    amount_usd: hosted_models.length > 0 ? run.cost_usd : 0,
    cost_source: "estimate",
    hosted_models,
    harness_models
  };
}

export function appendSpendEntry(entry: SpendLedgerEntry) {
  const { dir, file } = ledgerPath();
  mkdirSync(dir, { recursive: true });
  appendFileSync(file, `${JSON.stringify(SpendLedgerEntrySchema.parse(entry))}\n`);
}

export function readSpendEntries(): SpendLedgerEntry[] {
  const { file } = ledgerPath();
  if (!existsSync(file)) {
    return [];
  }
  const entries: SpendLedgerEntry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      entries.push(SpendLedgerEntrySchema.parse(JSON.parse(trimmed)));
    } catch {
      // Append-only means one corrupt line never poisons the ledger; skip it
      // and keep every other entry.
    }
  }
  return entries;
}

function utcDay(iso: string) {
  return iso.slice(0, 10);
}

function utcMonth(iso: string) {
  return iso.slice(0, 7);
}

export type SpendTotals = {
  day: string;
  day_usd: number;
  month: string;
  month_usd: number;
};

/** UTC calendar windows: an entry belongs to exactly one day and one month. */
export function spendTotals(entries: SpendLedgerEntry[], now: Date = new Date()): SpendTotals {
  const nowIso = now.toISOString();
  const day = utcDay(nowIso);
  const month = utcMonth(nowIso);
  let dayUsd = 0;
  let monthUsd = 0;
  for (const entry of entries) {
    if (utcMonth(entry.recorded_at) !== month) {
      continue;
    }
    monthUsd += entry.amount_usd;
    if (utcDay(entry.recorded_at) === day) {
      dayUsd += entry.amount_usd;
    }
  }
  return { day, day_usd: dayUsd, month, month_usd: monthUsd };
}

function capEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function configuredBudget(): { daily_usd?: number; monthly_usd?: number } {
  return {
    daily_usd: capEnv("FUSION_BUDGET_DAILY_USD"),
    monthly_usd: capEnv("FUSION_BUDGET_MONTHLY_USD")
  };
}

function capMessage(window: "day" | "month", capUsd: number, spentUsd: number, label: string) {
  const envVar = window === "day" ? "FUSION_BUDGET_DAILY_USD" : "FUSION_BUDGET_MONTHLY_USD";
  return (
    `${window === "day" ? "Daily" : "Monthly"} hosted spend cap reached: ` +
    `$${spentUsd.toFixed(4)} recorded ≥ $${capUsd.toFixed(4)} cap (UTC ${window} ${label}). ` +
    `Harness-only councils still run. Raise ${envVar}, or wait for the window to roll.`
  );
}

/**
 * Pre-flight budget check for a council about to run. No caps configured, or a
 * council composed entirely of plan-billed harness seats, is always admitted.
 */
export function assertRunWithinBudget(
  models: Array<string | undefined>,
  now: Date = new Date()
) {
  const caps = configuredBudget();
  if (caps.daily_usd === undefined && caps.monthly_usd === undefined) {
    return;
  }
  const hosted = models.filter(
    (model): model is string => Boolean(model) && !isHarnessModel(model as string)
  );
  if (hosted.length === 0) {
    return;
  }

  const totals = spendTotals(readSpendEntries(), now);
  if (caps.daily_usd !== undefined && totals.day_usd >= caps.daily_usd) {
    throw new FusionBudgetExceededError(
      capMessage("day", caps.daily_usd, totals.day_usd, totals.day),
      { window: "day", cap_usd: caps.daily_usd, spent_usd: totals.day_usd }
    );
  }
  if (caps.monthly_usd !== undefined && totals.month_usd >= caps.monthly_usd) {
    throw new FusionBudgetExceededError(
      capMessage("month", caps.monthly_usd, totals.month_usd, totals.month),
      { window: "month", cap_usd: caps.monthly_usd, spent_usd: totals.month_usd }
    );
  }
}

/**
 * Record a completed run in the ledger. All-harness runs are skipped (the
 * ledger tracks money, and plan-billed seats spend none). A write failure is
 * logged but never fails the run — the money is already spent; losing the run
 * on top of the ledger line would be strictly worse.
 */
export function recordRunSpend(run: SpendableRun): SpendLedgerEntry | undefined {
  try {
    const spend = hostedSpendForRun(run);
    if (spend.hosted_models.length === 0) {
      return undefined;
    }
    const entry: SpendLedgerEntry = {
      object: "fusion.spend",
      recorded_at: new Date().toISOString(),
      run_id: run.id,
      amount_usd: spend.amount_usd,
      cost_source: spend.cost_source,
      coverage_ratio: run.metadata.cost_coverage?.coverage_ratio,
      models: runModels(run),
      hosted_models: spend.hosted_models,
      harness_models: spend.harness_models
    };
    appendSpendEntry(entry);
    return entry;
  } catch (error) {
    console.error(
      `[fusion:budget] Failed to record spend for run ${run.id}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return undefined;
  }
}

export type FusionBudgetStatus = {
  object: "fusion.budget";
  ledger: "file";
  spend: SpendTotals;
  caps: { daily_usd?: number; monthly_usd?: number };
  exceeded: { daily: boolean; monthly: boolean };
};

export function budgetStatus(now: Date = new Date()): FusionBudgetStatus {
  const caps = configuredBudget();
  const spend = spendTotals(readSpendEntries(), now);
  return {
    object: "fusion.budget",
    ledger: "file",
    spend,
    caps,
    exceeded: {
      daily: caps.daily_usd !== undefined && spend.day_usd >= caps.daily_usd,
      monthly: caps.monthly_usd !== undefined && spend.month_usd >= caps.monthly_usd
    }
  };
}
