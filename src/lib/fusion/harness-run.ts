import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FusionConfigurationError } from "./errors.ts";
import { harnessProviderEnv, harnessProviders, type HarnessProviderId } from "./harness.ts";
import { shortId } from "./ids.ts";
import type { EffortLevel, ProviderCallMetadata, UsageRecord } from "./schemas.ts";

/**
 * Local harness execution.
 *
 * Claude Code and Codex are run as their official CLIs in non-interactive
 * "print" mode, scoped to web grounding and a scratch read-only sandbox. They
 * answer as the agents they are, but never edit files, never run approvals, and
 * never receive the user's workspace as their working directory. Output is
 * normalized into the same shapes Vercel AI Gateway model calls produce, so the
 * orchestrator does not care which backend answered.
 */

export type HarnessRunInput = {
  harness: HarnessProviderId;
  /** Harness-local model id, e.g. "opus", "sonnet", "gpt-5.1-codex". Optional. */
  model?: string;
  prompt: string;
  system?: string;
  /** Whether the harness may use web grounding tools. Defaults on for compatibility. */
  webEnabled?: boolean;
  /** Normalized thinking budget; mapped to each CLI's own effort knob. */
  effort?: EffortLevel;
  signal?: AbortSignal;
  timeoutMs?: number;
};

/**
 * Map our normalized effort to the Claude CLI `--effort` flag. Mirrors T3 Code:
 * low/medium/high are universal, and only opus-class models accept the top
 * `xhigh` tier — so `max` reaches `xhigh` on opus and otherwise caps at
 * `high` (sending an unsupported tier would error the call).
 */
export function claudeEffort(effort: EffortLevel, model?: string): string {
  if (effort === "minimal" || effort === "low") return "low";
  if (effort === "medium") return "medium";
  if (effort === "high") return "high";
  return /opus/i.test(model ?? "") ? "xhigh" : "high";
}

/**
 * Map our normalized effort to Codex `model_reasoning_effort`. Codex accepts
 * minimal | low | medium | high | xhigh (per T3 Code), so `max` → `xhigh`.
 */
export function codexEffort(effort: EffortLevel): string {
  return effort === "max" ? "xhigh" : effort;
}

function harnessWebEnabled(value: boolean | undefined) {
  return value !== false;
}

export function claudePrintArgs(input: {
  model?: string;
  system?: string;
  effort?: EffortLevel;
  webEnabled?: boolean;
}) {
  const args = [
    "-p",
    "--safe-mode",
    "--no-session-persistence",
    "--model",
    input.model ?? "sonnet",
    "--output-format",
    "json"
  ];
  if (input.system?.trim()) {
    args.push("--append-system-prompt", input.system);
  }
  if (input.effort) {
    args.push("--effort", claudeEffort(input.effort, input.model));
  }

  if (harnessWebEnabled(input.webEnabled)) {
    args.push("--tools", "WebSearch WebFetch", "--allowedTools", "WebSearch WebFetch");
  } else {
    args.push("--tools", "");
  }
  return args;
}

export function codexExecArgs(input: {
  model?: string;
  effort?: EffortLevel;
  webEnabled?: boolean;
  outputFile: string;
}) {
  return [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    ...(input.model ? ["-m", input.model] : []),
    ...(input.effort ? ["-c", `model_reasoning_effort=${codexEffort(input.effort)}`] : []),
    "-c",
    `tools.web_search=${harnessWebEnabled(input.webEnabled) ? "true" : "false"}`,
    "-s",
    "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "--json",
    "-o",
    input.outputFile,
    "-"
  ];
}

export type HarnessTextResult = {
  text: string;
  usage: UsageRecord;
  latency_ms: number;
  /** Incremental dollars spent. Zero for subscription-backed harness calls. */
  cost_usd: number;
  /** API-equivalent cost the CLI reported, when available (Claude Code does). */
  raw_cost_usd?: number;
  provider: HarnessProviderId;
  model?: string;
};

const MAX_CAPTURE_BYTES = 24 * 1024 * 1024;

function emptyUsage(): UsageRecord {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
}

function toInt(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function harnessState(id: HarnessProviderId) {
  const provider = harnessProviders().find((entry) => entry.id === id);
  if (!provider) {
    throw new FusionConfigurationError(`Unknown local harness "${id}".`);
  }
  return provider;
}

export function assertHarnessReady(id: HarnessProviderId) {
  const provider = harnessState(id);
  if (provider.status !== "ready") {
    throw new FusionConfigurationError(
      `${provider.label} local harness is not runnable: ${provider.reason}`
    );
  }
  return provider;
}

type SpawnResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: Error;
};

export function spawnCapture(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    input: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32"
      });
    } catch (error) {
      resolve({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnError: error instanceof Error ? error : new Error(String(error))
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const killChildGroup = () => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // Fall through to the direct child kill if the process group is gone
          // already or the platform rejected the negative pid.
        }
      }
      child.kill("SIGKILL");
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killChildGroup();
    }, options.timeoutMs);

    const onAbort = () => killChildGroup();
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    const finish = (result: SpawnResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURE_BYTES) {
        stdout += chunk.toString("utf8");
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURE_BYTES) {
        stderr += chunk.toString("utf8");
      }
    });

    child.on("error", (error) => {
      finish({ code: null, stdout, stderr, timedOut, spawnError: error });
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr, timedOut });
    });

    child.stdin?.on("error", () => {
      // Ignore EPIPE if the child exits before consuming stdin.
    });
    child.stdin?.write(options.input);
    child.stdin?.end();
  });
}

function failureMessage(result: SpawnResult, label: string) {
  if (result.spawnError) {
    return `${label} could not start: ${result.spawnError.message}`;
  }
  if (result.timedOut) {
    return `${label} timed out before producing a result.`;
  }
  const detail = result.stderr.trim() || result.stdout.trim();
  return `${label} exited with code ${result.code ?? "unknown"}${detail ? `: ${detail.slice(0, 600)}` : "."}`;
}

// Defensive fallback for older Codex runs that still load config and fail on a
// stale service_tier value. Current harness args pass --ignore-user-config, so
// this should rarely fire.
function codexFailureHint(message: string, env: NodeJS.ProcessEnv): string {
  if (/service_tier/i.test(message) && /unknown variant/i.test(message)) {
    const configPath = env.CODEX_HOME?.trim()
      ? join(env.CODEX_HOME.trim(), "config.toml")
      : "~/.codex/config.toml";
    return `${message}\n\nFix: open ${configPath} and set service_tier = "fast" (or delete that line), then rerun.`;
  }
  return message;
}

// ── Claude Code ───────────────────────────────────────────────────────────

type ClaudeJson = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

export function parseClaudeResult(stdout: string): { text: string; usage: UsageRecord; cost?: number } {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("Claude Code returned no output.");
  }

  let parsed: ClaudeJson;
  try {
    parsed = JSON.parse(trimmed) as ClaudeJson;
  } catch {
    // Defensive: a stray banner line before the JSON object.
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new Error("Claude Code output was not valid JSON.");
    }
    parsed = JSON.parse(trimmed.slice(start, end + 1)) as ClaudeJson;
  }

  if (parsed.is_error) {
    throw new Error(parsed.result?.trim() || "Claude Code reported an error result.");
  }

  const input = toInt(parsed.usage?.input_tokens) + toInt(parsed.usage?.cache_read_input_tokens) +
    toInt(parsed.usage?.cache_creation_input_tokens);
  const output = toInt(parsed.usage?.output_tokens);

  return {
    text: (parsed.result ?? "").trim(),
    usage: { input_tokens: input, output_tokens: output, total_tokens: input + output },
    cost: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : undefined
  };
}

// ── Codex ─────────────────────────────────────────────────────────────────

export function extractCodexUsage(stdout: string): UsageRecord {
  let input = 0;
  let output = 0;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    // Codex emits token-usage info under a few shapes across versions; accept
    // any object that carries an input/output token pair.
    const candidates = [
      event,
      (event as { msg?: Record<string, unknown> }).msg,
      (event as { info?: Record<string, unknown> }).info,
      (event as { usage?: Record<string, unknown> }).usage,
      ((event as { msg?: { info?: Record<string, unknown> } }).msg)?.info,
      ((event as { info?: { total_token_usage?: Record<string, unknown> } }).info)?.total_token_usage
    ];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") {
        continue;
      }
      const record = candidate as Record<string, unknown>;
      const inTok = record.input_tokens ?? record.prompt_tokens ?? record.input_token_count;
      const outTok = record.output_tokens ?? record.completion_tokens ?? record.output_token_count;
      if (typeof inTok === "number" || typeof outTok === "number") {
        input = Math.max(input, toInt(inTok));
        output = Math.max(output, toInt(outTok));
      }
    }
  }

  return { input_tokens: input, output_tokens: output, total_tokens: input + output };
}

export function extractCodexFallbackText(stdout: string): string {
  let latest = "";
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    // Newer `codex exec --json`: { type: "item.completed", item: { type: "agent_message", text } }
    const item = (event as { item?: Record<string, unknown> }).item;
    if (item && typeof item === "object") {
      const itemType = (item as { type?: unknown }).type;
      const itemText =
        (item as { text?: unknown }).text ?? (item as { message?: unknown }).message;
      if (
        typeof itemText === "string" &&
        (itemType === "agent_message" || itemType === "assistant_message" || itemType === "agentMessage")
      ) {
        latest = itemText;
      }
    }

    // Older shape: { msg: { type: "agent_message", message } }
    const msg = (event as { msg?: Record<string, unknown> }).msg ?? event;
    const type = (msg as { type?: unknown }).type;
    const message = (msg as { message?: unknown; text?: unknown }).message ??
      (msg as { text?: unknown }).text;
    if (
      typeof message === "string" &&
      (type === "agent_message" || type === "agent_message_delta")
    ) {
      latest = message;
    }
  }
  return latest.trim();
}

/** Find the most recent error / turn.failed message in a Codex JSONL stream. */
export function extractCodexError(stdout: string): string | undefined {
  let latest: string | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = (event as { type?: unknown }).type;
    if (type === "error" || type === "turn.failed") {
      const message =
        (event as { message?: unknown }).message ??
        ((event as { error?: { message?: unknown } }).error)?.message;
      if (typeof message === "string" && message.trim()) {
        latest = message.trim();
      }
    }
  }
  return latest;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function runHarnessText(input: HarnessRunInput): Promise<HarnessTextResult> {
  const provider = assertHarnessReady(input.harness);
  const command = provider.command_path ?? provider.command;
  const timeoutMs = input.timeoutMs ?? provider.timeout_ms;
  const env = harnessProviderEnv(input.harness);

  mkdirSync(provider.scratch_root, { recursive: true });
  const workdir = mkdtempSync(join(provider.scratch_root, "run-"));
  const started = Date.now();

  try {
    if (input.harness === "claude-code") {
      const args = claudePrintArgs(input);
      // Claude Code is an agent, so it answers with its own read-only tools rather
      // than a bare model. When web is enabled, `--tools` makes only web
      // search + fetch available (no
      // Bash/Edit/Write), and `--allowedTools` auto-approves them so they actually
      // run in non-interactive print mode — which otherwise denies every tool. A
      // panelist can ground itself in current sources without touching the host.
      // (Vercel AI Gateway models, which have no built-in tools, attach web separately.)

      const result = await spawnCapture(command, args, {
        cwd: workdir,
        env,
        input: input.prompt,
        timeoutMs,
        signal: input.signal
      });
      if (result.code !== 0 || result.spawnError || result.timedOut) {
        throw new Error(failureMessage(result, provider.label));
      }

      const parsed = parseClaudeResult(result.stdout);
      return {
        text: parsed.text,
        usage: parsed.usage,
        latency_ms: Date.now() - started,
        cost_usd: 0,
        raw_cost_usd: parsed.cost,
        provider: input.harness,
        model: input.model
      };
    }

    // Codex
    const lastMessageFile = join(workdir, "last-message.txt");
    // Codex answers as an agent inside its own read-only scratch sandbox.
    // OpenFusion does not mount the user's workspace into this run.
    const args = codexExecArgs({
      model: input.model,
      effort: input.effort,
      webEnabled: input.webEnabled,
      outputFile: lastMessageFile
    });
    const fullPrompt = input.system?.trim()
      ? `${input.system.trim()}\n\n${input.prompt}`
      : input.prompt;

    const result = await spawnCapture(command, args, {
      cwd: workdir,
      env,
      input: fullPrompt,
      timeoutMs,
      signal: input.signal
    });
    if (result.code !== 0 || result.spawnError || result.timedOut) {
      throw new Error(codexFailureHint(failureMessage(result, provider.label), env));
    }

    let text = "";
    try {
      text = readFileSync(lastMessageFile, "utf8").trim();
    } catch {
      text = "";
    }
    if (!text) {
      text = extractCodexFallbackText(result.stdout);
    }
    if (!text) {
      const codexError = extractCodexError(result.stdout);
      if (codexError) {
        throw new Error(`${provider.label}: ${codexError}`);
      }
    }

    return {
      text,
      usage: extractCodexUsage(result.stdout),
      latency_ms: Date.now() - started,
      cost_usd: 0,
      provider: input.harness,
      model: input.model
    };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

/**
 * Build provider-call metadata for a harness result. Each call gets a unique
 * generation id so cost aggregation and dedup treat repeated harness calls as
 * distinct generations.
 */
export function harnessProviderMetadata(
  modelId: string,
  result: HarnessTextResult
): ProviderCallMetadata {
  return {
    model: modelId,
    provider: result.provider,
    response_model: result.model,
    generation_id: shortId("harness"),
    total_cost_usd: result.cost_usd,
    upstream_inference_cost_usd: result.raw_cost_usd,
    latency_ms: result.latency_ms,
    prompt_tokens: result.usage.input_tokens,
    completion_tokens: result.usage.output_tokens,
    finish_reason: "stop"
  };
}
