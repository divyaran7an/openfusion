import type { HarnessProviderId } from "./harness.ts";

/**
 * A model id is routed to exactly one execution backend.
 *
 * Hosted and harness models are namespaced by their execution source. Bare model
 * ids keep the original behavior and route to the Vercel AI Gateway; explicit
 * `openrouter/...` ids route to OpenRouter.
 *
 * Reserved prefixes: `openrouter`, `codex`, and `claude-code`.
 */
export type ModelTarget =
  | { kind: "gateway"; model: string }
  | { kind: "openrouter"; model: string }
  | { kind: "harness"; harness: HarnessProviderId; model: string };

const HARNESS_PREFIX: Record<string, HarnessProviderId> = {
  "claude-code": "claude-code",
  codex: "codex"
};

export function resolveModelTarget(model: string): ModelTarget {
  const trimmed = model.trim();
  const separator = trimmed.indexOf("/");

  if (separator > 0) {
    const prefix = trimmed.slice(0, separator);
    const sub = trimmed.slice(separator + 1).trim();
    if (prefix === "openrouter" && sub) {
      return { kind: "openrouter", model: sub };
    }

    const harness = HARNESS_PREFIX[prefix];
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
  openrouter: boolean;
  harnesses: HarnessProviderId[];
};

/**
 * Inspect a set of model ids (panel + judge + outer) and report which
 * execution backends a run actually needs. This is what lets a harness-only
 * fusion run without a Vercel AI Gateway key, and a Vercel AI Gateway-only fusion run
 * without any local CLI.
 */
export function requiredBackends(models: Array<string | undefined>): RequiredBackends {
  let gateway = false;
  let openrouter = false;
  const harnesses = new Set<HarnessProviderId>();

  for (const model of models) {
    if (!model) {
      continue;
    }
    const target = resolveModelTarget(model);
    if (target.kind === "harness") {
      harnesses.add(target.harness);
    } else if (target.kind === "openrouter") {
      openrouter = true;
    } else {
      gateway = true;
    }
  }

  return { gateway, openrouter, harnesses: [...harnesses] };
}

/** The honest `runtime` label for a run, based on the backends it touches. */
export function runtimeLabel(
  models: Array<string | undefined>
): "gateway" | "openrouter" | "harness" | "mixed" {
  const backends = requiredBackends(models);
  const count =
    Number(backends.gateway) + Number(backends.openrouter) + Number(backends.harnesses.length > 0);
  if (count > 1) {
    return "mixed";
  }
  if (backends.harnesses.length > 0) {
    return "harness";
  }
  if (backends.openrouter) {
    return "openrouter";
  }
  return "gateway";
}
