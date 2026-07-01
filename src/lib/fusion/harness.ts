import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export type HarnessProviderId = "codex" | "claude-code";

export type HarnessProviderStatus =
  | "ready"
  | "disabled"
  | "missing_command";

export type HarnessProviderState = {
  id: HarnessProviderId;
  label: string;
  kind: "local_harness";
  enabled: boolean;
  installed: boolean;
  command: string;
  command_path?: string;
  status: HarnessProviderStatus;
  reason: string;
  timeout_ms: number;
  scratch_root: string;
  supports: {
    sessions: boolean;
    approvals: boolean;
    events: boolean;
    shell: boolean;
    file_edit: boolean;
    browser: boolean;
  };
};

type HarnessEnv = Record<string, string | undefined>;

type HarnessDefinition = {
  id: HarnessProviderId;
  label: string;
  commandEnv: string;
  defaultCommand: string;
  enabledEnv: string;
  enableHint: string;
};

const HARNESS_DEFINITIONS: HarnessDefinition[] = [
  {
    id: "codex",
    label: "Codex",
    commandEnv: "FUSION_CODEX_COMMAND",
    defaultCommand: "codex",
    enabledEnv: "FUSION_CODEX_HARNESS",
    enableHint: "Install the Codex CLI and sign in (codex), then it connects automatically."
  },
  {
    id: "claude-code",
    label: "Claude Code",
    commandEnv: "FUSION_CLAUDE_CODE_COMMAND",
    defaultCommand: "claude",
    enabledEnv: "FUSION_CLAUDE_CODE_HARNESS",
    enableHint: "Install the Claude Code CLI and sign in (claude), then it connects automatically."
  }
];

// A harness is on by default — if the CLI is installed and you're signed in, it
// just works. The env flag is only an explicit *opt-out* (set it to 0/false/off).
function envDisabled(name: string, env: HarnessEnv) {
  const value = env[name]?.trim().toLowerCase();
  return value === "0" || value === "false" || value === "no" || value === "off";
}

function positiveIntEnv(name: string, env: HarnessEnv, fallback: number) {
  const parsed = Number(env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function canExecute(path: string) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveExecutable(
  command: string,
  env: HarnessEnv = process.env
) {
  const trimmed = command.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.includes("/") || isAbsolute(trimmed)) {
    return canExecute(trimmed) ? trimmed : undefined;
  }

  return (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, trimmed))
    .find(canExecute);
}

export function harnessProviders(env: HarnessEnv = process.env) {
  const timeoutMs = positiveIntEnv("FUSION_HARNESS_TIMEOUT_MS", env, 10 * 60 * 1000);
  const scratchRoot = env.FUSION_HARNESS_SCRATCH_ROOT?.trim() || "/tmp/fusion-harness";

  return HARNESS_DEFINITIONS.map((definition): HarnessProviderState => {
    const command = env[definition.commandEnv]?.trim() || definition.defaultCommand;
    const commandPath = resolveExecutable(command, env);
    const enabled = !envDisabled(definition.enabledEnv, env);
    const installed = Boolean(commandPath);
    const status: HarnessProviderStatus = !enabled
      ? "disabled"
      : installed
        ? "ready"
        : "missing_command";

    return {
      id: definition.id,
      label: definition.label,
      kind: "local_harness",
      enabled,
      installed,
      command,
      command_path: commandPath,
      status,
      reason:
        status === "ready"
          ? "Connected — the local CLI is installed and Fusion routes through the read-only harness policy layer."
          : status === "missing_command"
            ? definition.enableHint
            : `Turned off via ${definition.enabledEnv}. Remove it (or set it to 1) to use ${definition.label}.`,
      timeout_ms: timeoutMs,
      scratch_root: scratchRoot,
      // Fusion drives these CLIs in read-only print mode only (`claude -p --tools ""`,
      // `codex exec -s read-only`). It never grants shell, file edits, approvals,
      // or a browser, so the capability map reflects that hard boundary — not what
      // the CLIs could do if driven interactively.
      supports: {
        sessions: false,
        approvals: false,
        events: true,
        shell: false,
        file_edit: false,
        browser: false
      }
    };
  });
}
