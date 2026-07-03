import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  harnessProviderEnv,
  harnessProviders,
  resolveExecutable
} from "../src/lib/fusion/harness.ts";

function executableFixture(name: string) {
  const directory = mkdtempSync(join(tmpdir(), "fusion-harness-"));
  const path = join(directory, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o700);
  return { directory, path };
}

test("resolveExecutable finds commands on an explicit PATH", () => {
  const fixture = executableFixture("codex");

  try {
    assert.equal(resolveExecutable("codex", { PATH: fixture.directory }), fixture.path);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("harnessProviders connects automatically when the CLI is installed", () => {
  const fixture = executableFixture("codex");
  const home = mkdtempSync(join(tmpdir(), "fusion-codex-home-"));
  const codexHome = join(home, ".codex");

  try {
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "auth.json"), "{}\n");
    // No enable flag needed — an installed CLI is ready by default.
    const auto = harnessProviders({
      PATH: fixture.directory,
      HOME: home,
      FUSION_CODEX_COMMAND: "codex",
      FUSION_CLAUDE_CODE_COMMAND: "missing-claude",
      FUSION_HARNESS_TIMEOUT_MS: "12345",
      FUSION_HARNESS_SCRATCH_ROOT: "/tmp/fusion-test-harness"
    });

    const codex = auto.find((provider) => provider.id === "codex");
    assert.equal(codex?.installed, true);
    assert.equal(codex?.enabled, true);
    assert.equal(codex?.status, "ready");
    assert.equal(codex?.timeout_ms, 12345);
    assert.equal(codex?.scratch_root, "/tmp/fusion-test-harness");
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("harnessProviders requires local auth or provider credentials before marking a CLI ready", () => {
  const fixture = executableFixture("codex");
  const home = mkdtempSync(join(tmpdir(), "fusion-codex-home-"));

  try {
    const missingAuth = harnessProviders({
      PATH: fixture.directory,
      HOME: home,
      FUSION_CODEX_COMMAND: "codex",
      FUSION_CLAUDE_CODE_COMMAND: "missing-claude"
    });

    const codex = missingAuth.find((provider) => provider.id === "codex");
    assert.equal(codex?.installed, true);
    assert.equal(codex?.status, "configuration_error");
    assert.match(codex?.reason ?? "", /codex login/);

    const credentialBacked = harnessProviders({
      PATH: fixture.directory,
      HOME: home,
      FUSION_CODEX_COMMAND: "codex",
      FUSION_CODEX_ENV_JSON: JSON.stringify({ OPENAI_API_KEY: "test-key" }),
      FUSION_CLAUDE_CODE_COMMAND: "missing-claude"
    });

    assert.equal(credentialBacked.find((provider) => provider.id === "codex")?.status, "ready");
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("harnessProviders can be explicitly turned off via the env flag", () => {
  const fixture = executableFixture("codex");

  try {
    const off = harnessProviders({
      PATH: fixture.directory,
      FUSION_CODEX_COMMAND: "codex",
      FUSION_CODEX_HARNESS: "0",
      FUSION_CLAUDE_CODE_COMMAND: "missing-claude"
    });

    const codex = off.find((provider) => provider.id === "codex");
    assert.equal(codex?.installed, true);
    assert.equal(codex?.enabled, false);
    assert.equal(codex?.status, "disabled");
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("harnessProviders reports missing commands when the CLI is absent", () => {
  const providers = harnessProviders({
    PATH: "",
    FUSION_CODEX_COMMAND: "missing-codex",
    FUSION_CLAUDE_CODE_COMMAND: "missing-claude"
  });

  const codex = providers.find((provider) => provider.id === "codex");
  assert.equal(codex?.enabled, true);
  assert.equal(codex?.installed, false);
  assert.equal(codex?.status, "missing_command");
  assert.match(codex?.reason ?? "", /codex login/);

  const claude = providers.find((provider) => provider.id === "claude-code");
  assert.equal(claude?.status, "missing_command");
  assert.match(claude?.reason ?? "", /claude auth login/);
});

test("harnessProviders ignores stale Codex user config because runtime passes --ignore-user-config", () => {
  const fixture = executableFixture("codex");
  const home = mkdtempSync(join(tmpdir(), "fusion-codex-home-"));
  const codexHome = join(home, ".codex");
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, "auth.json"), "{}\n");
  writeFileSync(join(codexHome, "config.toml"), 'service_tier = "default"\n');

  try {
    const providers = harnessProviders({
      PATH: fixture.directory,
      HOME: home,
      FUSION_CODEX_COMMAND: "codex",
      FUSION_CLAUDE_CODE_COMMAND: "missing-claude"
    });

    const codex = providers.find((provider) => provider.id === "codex");
    assert.equal(codex?.installed, true);
    assert.equal(codex?.enabled, true);
    assert.equal(codex?.status, "ready");
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("harnessProviders applies FUSION_CODEX_HOME auth without reading user config", () => {
  const fixture = executableFixture("codex");
  const codexHome = mkdtempSync(join(tmpdir(), "fusion-codex-home-"));
  writeFileSync(join(codexHome, "auth.json"), "{}\n");
  writeFileSync(join(codexHome, "config.toml"), 'service_tier = "default"\n');

  try {
    const providers = harnessProviders({
      PATH: fixture.directory,
      HOME: "/not-used",
      FUSION_CODEX_HOME: codexHome,
      FUSION_CODEX_COMMAND: "codex",
      FUSION_CLAUDE_CODE_COMMAND: "missing-claude"
    });

    const codex = providers.find((provider) => provider.id === "codex");
    assert.equal(codex?.status, "ready");
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("harnessProviderEnv applies isolated homes and provider env JSON", () => {
  const codexEnv = harnessProviderEnv("codex", {
    PATH: "/usr/bin",
    FUSION_CODEX_HOME: "/tmp/of-codex",
    FUSION_CODEX_ENV_JSON: JSON.stringify({
      OPENAI_BASE_URL: "http://127.0.0.1:3000/v1",
      OPENAI_API_KEY: "local-fusion"
    })
  });
  assert.equal(codexEnv.CODEX_HOME, "/tmp/of-codex");
  assert.equal(codexEnv.OPENAI_BASE_URL, "http://127.0.0.1:3000/v1");
  assert.equal(codexEnv.OPENAI_API_KEY, "local-fusion");

  const claudeEnv = harnessProviderEnv("claude-code", {
    HOME: "/tmp/original-home",
    FUSION_CLAUDE_CODE_HOME: "/tmp/of-claude",
    FUSION_CLAUDE_CODE_ENV_JSON: JSON.stringify({
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_AUTH_TOKEN: "sk-or-test",
      ANTHROPIC_API_KEY: ""
    })
  });
  assert.equal(claudeEnv.HOME, "/tmp/of-claude");
  assert.equal(claudeEnv.ANTHROPIC_BASE_URL, "https://openrouter.ai/api");
  assert.equal(claudeEnv.ANTHROPIC_AUTH_TOKEN, "sk-or-test");
  assert.equal(claudeEnv.ANTHROPIC_API_KEY, "");
});

test("harnessProviders rejects malformed provider env JSON", () => {
  const fixture = executableFixture("claude");

  try {
    const providers = harnessProviders({
      PATH: fixture.directory,
      FUSION_CODEX_COMMAND: "missing-codex",
      FUSION_CLAUDE_CODE_COMMAND: "claude",
      FUSION_CLAUDE_CODE_ENV_JSON: "{\"ANTHROPIC_AUTH_TOKEN\":123}"
    });

    const claude = providers.find((provider) => provider.id === "claude-code");
    assert.equal(claude?.installed, true);
    assert.equal(claude?.status, "configuration_error");
    assert.match(claude?.reason ?? "", /FUSION_CLAUDE_CODE_ENV_JSON\.ANTHROPIC_AUTH_TOKEN must be a string/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("harnessProviders rejects homes inside provider env JSON", () => {
  const fixture = executableFixture("codex");

  try {
    const providers = harnessProviders({
      PATH: fixture.directory,
      FUSION_CODEX_COMMAND: "codex",
      FUSION_CODEX_ENV_JSON: "{\"CODEX_HOME\":\"/tmp/wrong-place\"}",
      FUSION_CLAUDE_CODE_COMMAND: "missing-claude"
    });

    const codex = providers.find((provider) => provider.id === "codex");
    assert.equal(codex?.status, "configuration_error");
    assert.match(codex?.reason ?? "", /Use FUSION_CODEX_HOME instead/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("harnessProviders advertise a read-only capability boundary", () => {
  // Fusion drives the CLIs in read-only print mode, so no harness may ever claim
  // shell, file edits, approvals, or a browser — the studio renders this as truth.
  for (const provider of harnessProviders({ PATH: "" })) {
    assert.equal(provider.supports.shell, false, `${provider.id} must not claim shell`);
    assert.equal(provider.supports.file_edit, false, `${provider.id} must not claim file_edit`);
    assert.equal(provider.supports.approvals, false, `${provider.id} must not claim approvals`);
    assert.equal(provider.supports.browser, false, `${provider.id} must not claim browser`);
  }
});
