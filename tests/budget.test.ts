import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  appendSpendEntry,
  assertRunWithinBudget,
  budgetStatus,
  hostedSpendForRun,
  readSpendEntries,
  recordRunSpend,
  spendTotals,
  type SpendLedgerEntry
} from "../src/lib/fusion/budget.ts";
import { FusionBudgetExceededError } from "../src/lib/fusion/errors.ts";
import type { FusionRun } from "../src/lib/fusion/types.ts";

function withDataDir<T>(run: (dir: string) => T): T {
  const previous = process.env.FUSION_DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), "fusion-budget-"));
  process.env.FUSION_DATA_DIR = dir;
  try {
    return run(dir);
  } finally {
    if (previous === undefined) delete process.env.FUSION_DATA_DIR;
    else process.env.FUSION_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

function withBudgetEnv<T>(caps: { daily?: string; monthly?: string }, run: () => T): T {
  const previousDaily = process.env.FUSION_BUDGET_DAILY_USD;
  const previousMonthly = process.env.FUSION_BUDGET_MONTHLY_USD;
  if (caps.daily === undefined) delete process.env.FUSION_BUDGET_DAILY_USD;
  else process.env.FUSION_BUDGET_DAILY_USD = caps.daily;
  if (caps.monthly === undefined) delete process.env.FUSION_BUDGET_MONTHLY_USD;
  else process.env.FUSION_BUDGET_MONTHLY_USD = caps.monthly;
  try {
    return run();
  } finally {
    if (previousDaily === undefined) delete process.env.FUSION_BUDGET_DAILY_USD;
    else process.env.FUSION_BUDGET_DAILY_USD = previousDaily;
    if (previousMonthly === undefined) delete process.env.FUSION_BUDGET_MONTHLY_USD;
    else process.env.FUSION_BUDGET_MONTHLY_USD = previousMonthly;
  }
}

function fixtureRun(input: Partial<FusionRun> = {}): FusionRun {
  return {
    id: "run_budget",
    object: "fusion.run",
    created_at: "2026-07-08T00:00:00.000Z",
    completed_at: "2026-07-08T00:00:01.000Z",
    mode: "openfusion",
    requested_model: "openfusion",
    status: "ok",
    degraded: false,
    prompt: "ok",
    final: "ok",
    responses: [],
    failed_models: [],
    sources: [],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    latency_ms: { panel_max: 1, judge: 0, synthesis: 0, end_to_end: 1 },
    cost_usd: 0.05,
    metadata: {
      trace_id: "trc_budget",
      panel_size: 2,
      panel_models: ["openai/gpt-5.5", "claude-code/opus"],
      outer_model: "anthropic/claude-opus-4.8",
      runtime: "mixed",
      web_enabled: false,
      web_tools_available: false,
      web_fetch_available: false,
      local_tools_enabled: false,
      local_tools_available: false,
      judge_web_tools_available: false,
      outer_web_tools_available: false,
      web_extract_available: false
    },
    ...input
  };
}

function ledgerEntry(input: Partial<SpendLedgerEntry> = {}): SpendLedgerEntry {
  return {
    object: "fusion.spend",
    recorded_at: "2026-07-08T10:00:00.000Z",
    run_id: "run_x",
    amount_usd: 1,
    cost_source: "provider_reported",
    models: ["openai/gpt-5.5"],
    hosted_models: ["openai/gpt-5.5"],
    harness_models: [],
    ...input
  };
}

test("hostedSpendForRun sums only non-harness provider generations", () => {
  const run = fixtureRun({
    metadata: {
      ...fixtureRun().metadata,
      cost_source: "provider_reported",
      provider_generations: [
        { model: "openai/gpt-5.5", provider: "openai", total_cost_usd: 0.004 },
        // Harness generation with a nonzero API-equivalent price must still be
        // excluded — the exclusion is structural, not "harness happens to be 0".
        { model: "claude-code/opus", provider: "claude-code", total_cost_usd: 0.9 },
        { model: "anthropic/claude-opus-4.8", provider: "anthropic", total_cost_usd: 0.006 }
      ]
    }
  });

  const spend = hostedSpendForRun(run);
  assert.equal(spend.amount_usd, 0.01);
  assert.equal(spend.cost_source, "provider_reported");
  assert.deepEqual(spend.hosted_models, ["openai/gpt-5.5", "anthropic/claude-opus-4.8"]);
  assert.deepEqual(spend.harness_models, ["claude-code/opus"]);
});

test("hostedSpendForRun falls back to the run estimate when nothing is priced", () => {
  const spend = hostedSpendForRun(fixtureRun());
  assert.equal(spend.amount_usd, 0.05);
  assert.equal(spend.cost_source, "estimate");
});

test("hostedSpendForRun reports zero for an all-harness council", () => {
  const run = fixtureRun({
    cost_usd: 0,
    metadata: {
      ...fixtureRun().metadata,
      panel_models: ["claude-code/sonnet", "codex/gpt-5.5"],
      outer_model: "claude-code/opus",
      runtime: "harness"
    }
  });
  const spend = hostedSpendForRun(run);
  assert.equal(spend.amount_usd, 0);
  assert.deepEqual(spend.hosted_models, []);
});

test("spendTotals uses UTC calendar day and month windows", () => {
  const entries = [
    ledgerEntry({ recorded_at: "2026-07-08T00:00:01.000Z", amount_usd: 1 }),
    ledgerEntry({ recorded_at: "2026-07-08T23:59:59.000Z", amount_usd: 2 }),
    ledgerEntry({ recorded_at: "2026-07-07T12:00:00.000Z", amount_usd: 4 }),
    ledgerEntry({ recorded_at: "2026-06-30T23:59:59.000Z", amount_usd: 8 })
  ];
  const totals = spendTotals(entries, new Date("2026-07-08T12:00:00.000Z"));
  assert.equal(totals.day, "2026-07-08");
  assert.equal(totals.day_usd, 3);
  assert.equal(totals.month, "2026-07");
  assert.equal(totals.month_usd, 7);
});

test("spend ledger appends, reads back, and skips corrupt lines", () => {
  withDataDir((dir) => {
    appendSpendEntry(ledgerEntry({ run_id: "run_1" }));
    appendFileSync(join(dir, "spend-ledger.jsonl"), "{ not json\n");
    appendSpendEntry(ledgerEntry({ run_id: "run_2", amount_usd: 2 }));

    const entries = readSpendEntries();
    assert.equal(entries.length, 2);
    assert.deepEqual(
      entries.map((entry) => entry.run_id),
      ["run_1", "run_2"]
    );
  });
});

test("recordRunSpend ledgers hosted runs and skips all-harness runs", () => {
  withDataDir((dir) => {
    const recorded = recordRunSpend(fixtureRun());
    assert.equal(recorded?.run_id, "run_budget");
    assert.equal(recorded?.cost_source, "estimate");

    const skipped = recordRunSpend(
      fixtureRun({
        cost_usd: 0,
        metadata: {
          ...fixtureRun().metadata,
          panel_models: ["claude-code/sonnet"],
          outer_model: "codex/gpt-5.5",
          runtime: "harness"
        }
      })
    );
    assert.equal(skipped, undefined);

    const lines = readFileSync(join(dir, "spend-ledger.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean);
    assert.equal(lines.length, 1);
  });
});

test("assertRunWithinBudget is a no-op without caps and refuses at the cap boundary", () => {
  withDataDir(() => {
    appendSpendEntry(ledgerEntry({ amount_usd: 5, recorded_at: new Date().toISOString() }));

    // No caps configured: nothing happens.
    withBudgetEnv({}, () => {
      assertRunWithinBudget(["openai/gpt-5.5"]);
    });

    // Recorded spend >= cap (boundary equality) refuses hosted runs.
    withBudgetEnv({ daily: "5" }, () => {
      assert.throws(
        () => assertRunWithinBudget(["openai/gpt-5.5", "anthropic/claude-opus-4.8"]),
        (error: unknown) => {
          assert.ok(error instanceof FusionBudgetExceededError);
          assert.equal(error.details.window, "day");
          assert.equal(error.details.cap_usd, 5);
          assert.equal(error.details.spent_usd, 5);
          assert.match(error.message, /FUSION_BUDGET_DAILY_USD/);
          return true;
        }
      );
    });

    // Under the cap passes.
    withBudgetEnv({ daily: "5.01" }, () => {
      assertRunWithinBudget(["openai/gpt-5.5"]);
    });

    // Monthly cap refuses independently of the daily one.
    withBudgetEnv({ monthly: "4" }, () => {
      assert.throws(
        () => assertRunWithinBudget(["openai/gpt-5.5"]),
        (error: unknown) =>
          error instanceof FusionBudgetExceededError && error.details.window === "month"
      );
    });
  });
});

test("assertRunWithinBudget never blocks an all-harness council", () => {
  withDataDir(() => {
    appendSpendEntry(ledgerEntry({ amount_usd: 100, recorded_at: new Date().toISOString() }));
    withBudgetEnv({ daily: "1", monthly: "1" }, () => {
      assertRunWithinBudget(["claude-code/opus", "codex/gpt-5.5", "claude-code/sonnet"]);
    });
  });
});

test("budgetStatus reports spend, caps, and exceeded flags", () => {
  withDataDir(() => {
    appendSpendEntry(ledgerEntry({ amount_usd: 3, recorded_at: new Date().toISOString() }));
    const status = withBudgetEnv({ daily: "2", monthly: "50" }, () => budgetStatus());
    assert.equal(status.object, "fusion.budget");
    assert.equal(status.ledger, "file");
    assert.equal(status.spend.day_usd, 3);
    assert.equal(status.caps.daily_usd, 2);
    assert.equal(status.exceeded.daily, true);
    assert.equal(status.exceeded.monthly, false);
  });
});
