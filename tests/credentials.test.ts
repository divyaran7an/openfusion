import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getStoredGatewayKey,
  getStoredOpenRouterKey,
  setStoredGatewayKey,
  setStoredOpenRouterKey
} from "../src/lib/fusion/credentials.ts";

test("gateway key store: set (trimmed), read, and clear", () => {
  const dir = mkdtempSync(join(tmpdir(), "fusion-cred-"));
  const previous = process.env.FUSION_DATA_DIR;
  process.env.FUSION_DATA_DIR = dir;
  try {
    assert.equal(getStoredGatewayKey(), undefined);

    setStoredGatewayKey("  sk-test-123  ");
    assert.equal(getStoredGatewayKey(), "sk-test-123");

    // An empty string clears the key rather than storing whitespace.
    setStoredGatewayKey("");
    assert.equal(getStoredGatewayKey(), undefined);
  } finally {
    if (previous === undefined) {
      delete process.env.FUSION_DATA_DIR;
    } else {
      process.env.FUSION_DATA_DIR = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenRouter key store: set (trimmed), read, and clear", () => {
  const dir = mkdtempSync(join(tmpdir(), "fusion-cred-"));
  const previous = process.env.FUSION_DATA_DIR;
  process.env.FUSION_DATA_DIR = dir;
  try {
    assert.equal(getStoredOpenRouterKey(), undefined);

    setStoredOpenRouterKey("  sk-or-test-123  ");
    assert.equal(getStoredOpenRouterKey(), "sk-or-test-123");

    setStoredOpenRouterKey("");
    assert.equal(getStoredOpenRouterKey(), undefined);
  } finally {
    if (previous === undefined) {
      delete process.env.FUSION_DATA_DIR;
    } else {
      process.env.FUSION_DATA_DIR = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
