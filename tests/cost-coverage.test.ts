import assert from "node:assert/strict";
import test from "node:test";

import { providerCostReport } from "../src/lib/fusion/costing.ts";

test("providerCostReport uses Gateway cost only when every expected call is priced", () => {
  const report = providerCostReport(
    [
      {
        model: "deepseek/deepseek-v4-pro",
        provider: "gateway",
        generation_id: "gen_a",
        total_cost_usd: 0.0002
      },
      {
        model: "openai/gpt-5.5",
        provider: "gateway",
        generation_id: "gen_b",
        total_cost_usd: 0.0003
      }
    ],
    2
  );

  assert.equal(report.cost_usd, 0.0005);
  assert.equal(report.cost_source, "provider_reported");
  assert.deepEqual(report.cost_coverage, {
    expected_provider_calls: 2,
    priced_provider_calls: 2,
    missing_provider_calls: 0,
    coverage_ratio: 1
  });
});

test("providerCostReport keeps partial Gateway pricing visible while returning estimate source", () => {
  const report = providerCostReport(
    [
      {
        model: "deepseek/deepseek-v4-pro",
        provider: "gateway",
        generation_id: "gen_a",
        total_cost_usd: 0.0002
      },
      {
        model: "openai/gpt-5.5",
        provider: "gateway",
        generation_id: "gen_b"
      }
    ],
    3
  );

  assert.equal(report.cost_usd, undefined);
  assert.equal(report.cost_source, "estimate");
  assert.deepEqual(report.cost_coverage, {
    expected_provider_calls: 3,
    priced_provider_calls: 1,
    missing_provider_calls: 2,
    coverage_ratio: 0.3333
  });
});

test("providerCostReport treats no expected provider calls as unpriced but fully covered", () => {
  const report = providerCostReport([], 0);

  assert.equal(report.cost_usd, undefined);
  assert.equal(report.cost_source, "estimate");
  assert.deepEqual(report.cost_coverage, {
    expected_provider_calls: 0,
    priced_provider_calls: 0,
    missing_provider_calls: 0,
    coverage_ratio: 1
  });
});
