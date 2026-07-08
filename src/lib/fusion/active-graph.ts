import { FusionConfigurationError } from "./errors.ts";
import { graphToOverride, validateGraph } from "./graph.ts";
import { getActiveGraph } from "./graph-store.ts";
import type { FusionOverride } from "./schemas.ts";

/**
 * Every run path executes the user's active graph — nothing else. The graph
 * supplies the panel / judge / synthesizer models; an explicit per-request
 * override (e.g. the Fusion plugin with `analysis_models`, or a native run
 * request with `fusion.panel_models`) still wins where provided.
 *
 * There are no fallbacks: if the active graph isn't a runnable council, the
 * call fails loudly with the validation reason instead of quietly running some
 * default set of models the user never chose.
 */
export function mergeActiveGraph(
  requestOverride: FusionOverride | undefined
): FusionOverride | undefined {
  if (requestOverride?.panel_models) {
    return requestOverride;
  }
  const graph = getActiveGraph();
  const validation = validateGraph(graph);
  if (!validation.ok) {
    throw new FusionConfigurationError(
      `Your OpenFusion graph isn't runnable yet. ${validation.errors.join(" ")} Open the studio and finish wiring the council.`
    );
  }
  const base = graphToOverride(graph);
  if (!requestOverride) {
    return base;
  }
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(requestOverride)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged as FusionOverride;
}
