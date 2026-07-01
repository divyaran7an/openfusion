import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { hasWebFetchFor, hasWebToolsFor } from "../src/lib/fusion/provider.ts";

function executableFixture(name: string) {
  const directory = mkdtempSync(join(tmpdir(), "fusion-provider-web-"));
  const path = join(directory, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o700);
  return { directory, path };
}

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const snapshot = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      if (
        key.startsWith("FUSION_") ||
        key === "AI_GATEWAY_API_KEY" ||
        key === "VERCEL_OIDC_TOKEN" ||
        key === "OPENROUTER_API_KEY" ||
        key === "PARALLEL_API_KEY"
      ) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, env);
    fn();
  } finally {
    process.env = snapshot;
  }
}

test("OpenRouter keyed nodes advertise server-side search and fetch", () => {
  withEnv({ OPENROUTER_API_KEY: "sk-or-test" }, () => {
    assert.equal(hasWebToolsFor("openrouter/openai/gpt-5.5", true), true);
    assert.equal(hasWebFetchFor("openrouter/openai/gpt-5.5", true), true);
  });
});

test("Gateway keyed nodes advertise search plus OpenFusion local fetch", () => {
  withEnv({ AI_GATEWAY_API_KEY: "vck_test" }, () => {
    assert.equal(hasWebToolsFor("openai/gpt-5.5", true), true);
    assert.equal(hasWebFetchFor("openai/gpt-5.5", true), true);
  });
});

test("Claude Code harness nodes advertise the CLI web search and fetch tools", () => {
  const fixture = executableFixture("claude");
  const home = mkdtempSync(join(tmpdir(), "fusion-claude-web-home-"));
  writeFileSync(join(home, ".claude.json"), "{}\n");

  try {
    withEnv(
      {
        PATH: fixture.directory,
        HOME: home,
        FUSION_CODEX_COMMAND: "missing-codex",
        FUSION_CLAUDE_CODE_COMMAND: "claude"
      },
      () => {
        assert.equal(hasWebToolsFor("claude-code/opus", true), true);
        assert.equal(hasWebFetchFor("claude-code/opus", true), true);
      }
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("Codex harness nodes advertise web search but not fetch", () => {
  const fixture = executableFixture("codex");
  const codexHome = mkdtempSync(join(tmpdir(), "fusion-codex-web-home-"));
  writeFileSync(join(codexHome, "auth.json"), "{}\n");

  try {
    withEnv(
      {
        PATH: fixture.directory,
        FUSION_CODEX_HOME: codexHome,
        FUSION_CODEX_COMMAND: "codex",
        FUSION_CLAUDE_CODE_COMMAND: "missing-claude"
      },
      () => {
        assert.equal(hasWebToolsFor("codex/gpt-5.5", true), true);
        assert.equal(hasWebFetchFor("codex/gpt-5.5", true), false);
      }
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});
