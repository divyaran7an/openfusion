import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
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

  try {
    // No enable flag needed — an installed CLI is ready by default.
    const auto = harnessProviders({
      PATH: fixture.directory,
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
