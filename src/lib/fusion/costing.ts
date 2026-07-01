import type { CostCoverage, ProviderCallMetadata } from "./schemas";

type CostSource = "estimate" | "gateway_generation";

export function providerCostReport(
  entries: ProviderCallMetadata[] | undefined,
  expectedCount: number
): {
  cost_usd?: number;
  cost_source: CostSource;
  cost_coverage: CostCoverage;
} {
  const generationEntries = entries ?? [];
  const pricedEntries = generationEntries.filter(
    (entry) => typeof entry.total_cost_usd === "number"
  );
  const pricedProviderCalls = Math.min(pricedEntries.length, expectedCount);
  const allExpectedCallsPriced =
    expectedCount > 0 &&
    generationEntries.length >= expectedCount &&
    generationEntries.every((entry) => typeof entry.total_cost_usd === "number");
  const costUsd = allExpectedCallsPriced
    ? Number(
        generationEntries
          .reduce((sum, entry) => sum + (entry.total_cost_usd ?? 0), 0)
          .toFixed(6)
      )
    : undefined;

  return {
    cost_usd: costUsd,
    cost_source: costUsd === undefined ? "estimate" : "gateway_generation",
    cost_coverage: {
      expected_provider_calls: expectedCount,
      priced_provider_calls: pricedProviderCalls,
      missing_provider_calls: Math.max(0, expectedCount - pricedProviderCalls),
      coverage_ratio:
        expectedCount === 0
          ? 1
          : Number((pricedProviderCalls / expectedCount).toFixed(4))
    }
  };
}
