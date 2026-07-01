import type { HarnessProviderId } from "./harness.ts";

/**
 * A model id is routed to exactly one execution backend.
 *
 * Harness models are namespaced by their harness id, e.g. `claude-code/opus`
 * or `codex/gpt-5.1-codex`. Everything else (including Gateway provider ids
 * like `anthropic/claude-opus-4.8`) routes to the Vercel AI Gateway.
 *
 * The harness prefixes are reserved words: no Vercel AI Gateway provider is
 * named `codex` or `claude-code`, so the first path segment is an unambiguous
 * discriminator.
 */
export type ModelTarget =
  | { kind: "gateway"; model: string }
  | { kind: "harness"; harness: HarnessProviderId; model: string };

const HARNESS_PREFIX: Record<string, HarnessProviderId> = {
  "claude-code": "claude-code",
  codex: "codex"
};

export function resolveModelTarget(model: string): ModelTarget {
  const trimmed = model.trim();
  const separator = trimmed.indexOf("/");

  if (separator > 0) {
    const harness = HARNESS_PREFIX[trimmed.slice(0, separator)];
    const sub = trimmed.slice(separator + 1).trim();
    if (harness && sub) {
      return { kind: "harness", harness, model: sub };
    }
  }

  return { kind: "gateway", model: trimmed };
}

export function isHarnessModel(model: string) {
  return resolveModelTarget(model).kind === "harness";
}

export function harnessForModel(model: string): HarnessProviderId | undefined {
  const target = resolveModelTarget(model);
  return target.kind === "harness" ? target.harness : undefined;
}

export type RequiredBackends = {
  gateway: boolean;
  harnesses: HarnessProviderId[];
};

/**
 * Inspect a set of model ids (panel + judge + outer) and report which
 * execution backends a run actually needs. This is what lets a harness-only
 * fusion run without an AI Gateway key, and a Gateway-only fusion run
 * without any local CLI.
 */
export function requiredBackends(models: Array<string | undefined>): RequiredBackends {
  let gateway = false;
  const harnesses = new Set<HarnessProviderId>();

  for (const model of models) {
    if (!model) {
      continue;
    }
    const target = resolveModelTarget(model);
    if (target.kind === "harness") {
      harnesses.add(target.harness);
    } else {
      gateway = true;
    }
  }

  return { gateway, harnesses: [...harnesses] };
}

/** The honest `runtime` label for a run, based on the backends it touches. */
export function runtimeLabel(
  models: Array<string | undefined>
): "gateway" | "harness" | "mixed" {
  const backends = requiredBackends(models);
  if (backends.gateway && backends.harnesses.length > 0) {
    return "mixed";
  }
  if (backends.harnesses.length > 0) {
    return "harness";
  }
  return "gateway";
}
