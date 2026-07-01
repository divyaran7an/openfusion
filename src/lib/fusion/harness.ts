import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export type HarnessProviderId = "codex" | "claude-code";

export type HarnessProviderStatus =
  | "ready"
  | "disabled"
  | "missing_command"
  | "configuration_error";

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
  envJsonEnv: string;
  enableHint: string;
};

const HARNESS_DEFINITIONS: HarnessDefinition[] = [
  {
    id: "codex",
    label: "Codex",
    commandEnv: "FUSION_CODEX_COMMAND",
    defaultCommand: "codex",
    enabledEnv: "FUSION_CODEX_HARNESS",
    envJsonEnv: "FUSION_CODEX_ENV_JSON",
    enableHint: "Install the Codex CLI and sign in with `codex login`, then it connects automatically."
  },
  {
    id: "claude-code",
    label: "Claude Code",
    commandEnv: "FUSION_CLAUDE_CODE_COMMAND",
    defaultCommand: "claude",
    enabledEnv: "FUSION_CLAUDE_CODE_HARNESS",
    envJsonEnv: "FUSION_CLAUDE_CODE_ENV_JSON",
    enableHint: "Install the Claude Code CLI and sign in with `claude auth login`, then it connects automatically."
  }
];

// A harness is on by default. If the CLI is installed and you're signed in, it
// just works. The env flag is only an explicit *opt-out* (set it to 0/false/off).
function envDisabled(name: string, env: HarnessEnv) {
  const value = env[name]?.trim().toLowerCase();
  return value === "0" || value === "false" || value === "no" || value === "off";
}

function positiveIntEnv(name: string, env: HarnessEnv, fallback: number) {
  const parsed = Number(env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function providerHome(id: HarnessProviderId, env: HarnessEnv) {
  if (id === "codex") {
    return env.FUSION_CODEX_HOME?.trim() || env.CODEX_HOME?.trim() || "";
  }
  return env.FUSION_CLAUDE_CODE_HOME?.trim() || "";
}

function providerEnvJsonName(id: HarnessProviderId) {
  return id === "codex" ? "FUSION_CODEX_ENV_JSON" : "FUSION_CLAUDE_CODE_ENV_JSON";
}

function parseProviderEnvJson(
  name: string,
  env: HarnessEnv,
  reservedKeys: string[] = []
): HarnessEnv {
  const raw = env[name]?.trim();
  if (!raw) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${name} must be valid JSON: ${message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object of environment variable names to string values.`);
  }

  const result: HarnessEnv = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`${name} contains invalid environment variable name "${key}".`);
    }
    if (typeof value !== "string") {
      throw new Error(`${name}.${key} must be a string.`);
    }
    if (reservedKeys.includes(key)) {
      throw new Error(`${name}.${key} is reserved. Use ${key === "CODEX_HOME" ? "FUSION_CODEX_HOME" : "FUSION_CLAUDE_CODE_HOME"} instead.`);
    }
    result[key] = value;
  }
  return result;
}

function providerReservedEnvKeys(id: HarnessProviderId) {
  return id === "codex" ? ["CODEX_HOME"] : ["HOME"];
}

function providerEnvJsonError(definition: HarnessDefinition, env: HarnessEnv) {
  try {
    parseProviderEnvJson(definition.envJsonEnv, env, providerReservedEnvKeys(definition.id));
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function harnessProviderEnv(
  id: HarnessProviderId,
  baseEnv: HarnessEnv = process.env
): NodeJS.ProcessEnv {
  const env = { ...baseEnv } as NodeJS.ProcessEnv;
  const home = providerHome(id, baseEnv);

  if (id === "codex" && home) {
    env.CODEX_HOME = home;
  }
  if (id === "claude-code" && home) {
    env.HOME = home;
  }

  Object.assign(env, parseProviderEnvJson(providerEnvJsonName(id), baseEnv, providerReservedEnvKeys(id)));
  return env;
}

function codexAuthPath(env: HarnessEnv) {
  const codexHome = providerHome("codex", env);
  if (codexHome) {
    return join(codexHome, "auth.json");
  }
  return join(env.HOME?.trim() || homedir(), ".codex", "auth.json");
}

function hasProviderCredentialEnv(id: HarnessProviderId, env: HarnessEnv) {
  const overlay = parseProviderEnvJson(providerEnvJsonName(id), env, providerReservedEnvKeys(id));
  const merged = { ...env, ...overlay };
  if (id === "codex") {
    return Boolean(
      merged.OPENAI_API_KEY?.trim() ||
        merged.CODEX_API_KEY?.trim() ||
        merged.OPENAI_AUTH_TOKEN?.trim()
    );
  }
  return Boolean(
    merged.ANTHROPIC_AUTH_TOKEN?.trim() ||
      merged.ANTHROPIC_API_KEY?.trim() ||
      merged.CLAUDE_CODE_AUTH_TOKEN?.trim()
  );
}

function claudeAuthPaths(env: HarnessEnv) {
  const home = providerHome("claude-code", env) || env.HOME?.trim() || homedir();
  return [join(home, ".claude", ".credentials.json"), join(home, ".claude.json")];
}

function harnessAuthError(id: HarnessProviderId, env: HarnessEnv) {
  if (hasProviderCredentialEnv(id, env)) {
    return undefined;
  }

  if (id === "codex") {
    const path = codexAuthPath(env);
    return existsSync(path)
      ? undefined
      : `Codex CLI is not signed in for this CODEX_HOME. Run \`codex login\`, then recheck.`;
  }

  const paths = claudeAuthPaths(env);
  return paths.some((path) => existsSync(path))
    ? undefined
    : `Claude Code CLI is not signed in for this HOME. Run \`claude auth login\`, then recheck.`;
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
    const envJsonError = enabled ? providerEnvJsonError(definition, env) : undefined;
    const configurationError =
      envJsonError ??
      (enabled && installed ? harnessAuthError(definition.id, env) : undefined);
    const status: HarnessProviderStatus = !enabled
      ? "disabled"
      : configurationError
        ? "configuration_error"
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
          ? "Connected. The local CLI is installed, auth is present, and Fusion routes through the read-only harness policy layer."
          : status === "configuration_error"
            ? configurationError ?? "Local harness configuration is invalid."
          : status === "missing_command"
            ? definition.enableHint
            : `Turned off via ${definition.enabledEnv}. Remove it (or set it to 1) to use ${definition.label}.`,
      timeout_ms: timeoutMs,
      scratch_root: scratchRoot,
      // Fusion drives these CLIs in isolated read-only print mode only
      // (`claude -p --safe-mode --tools "WebSearch WebFetch"`,
      // `codex exec --ignore-user-config --ignore-rules -s read-only`).
      // It never grants shell, file edits, approvals, or a browser, so the
      // capability map reflects that hard boundary, not what the CLIs could do
      // if driven interactively.
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
