import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FULL_CLAUDE_CLI_CAPABILITIES,
  claudeCliWarnings,
  claudeEffort,
  claudePrintArgs,
  codexExecArgs,
  codexEffort,
  extractCodexError,
  extractCodexFallbackText,
  extractCodexUsage,
  parseClaudeCliCapabilities,
  parseClaudeResult,
  spawnCapture
} from "../src/lib/fusion/harness-run.ts";

async function eventuallyProcessGone(pid: number) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
        return true;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test("parseClaudeResult extracts text, usage and cost from --output-format json", () => {
  const stdout = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "the answer",
    total_cost_usd: 0.0123,
    usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 50 }
  });
  const parsed = parseClaudeResult(stdout);
  assert.equal(parsed.text, "the answer");
  assert.equal(parsed.usage.input_tokens, 15);
  assert.equal(parsed.usage.output_tokens, 50);
  assert.equal(parsed.usage.total_tokens, 65);
  assert.equal(parsed.cost, 0.0123);
});

test("parseClaudeResult tolerates a banner line before the JSON object", () => {
  const stdout = `startup banner\n${JSON.stringify({
    result: "ok",
    usage: { input_tokens: 1, output_tokens: 2 }
  })}`;
  const parsed = parseClaudeResult(stdout);
  assert.equal(parsed.text, "ok");
  assert.equal(parsed.usage.total_tokens, 3);
});

test("parseClaudeResult throws on an error result", () => {
  assert.throws(() => parseClaudeResult(JSON.stringify({ is_error: true, result: "boom" })), /boom/);
});

test("extractCodexUsage finds token counts across event shapes", () => {
  const lines = [
    JSON.stringify({ id: "1", msg: { type: "agent_message", message: "hi" } }),
    JSON.stringify({ type: "token_count", info: { input_tokens: 12, output_tokens: 34 } })
  ].join("\n");
  const usage = extractCodexUsage(lines);
  assert.equal(usage.input_tokens, 12);
  assert.equal(usage.output_tokens, 34);
  assert.equal(usage.total_tokens, 46);
});

test("extractCodexUsage returns zeros when no usage event is present", () => {
  const usage = extractCodexUsage(JSON.stringify({ msg: { type: "agent_message", message: "hi" } }));
  assert.equal(usage.total_tokens, 0);
});

test("extractCodexFallbackText returns the last agent message", () => {
  const lines = [
    JSON.stringify({ msg: { type: "agent_message", message: "first" } }),
    JSON.stringify({ msg: { type: "agent_message", message: "final" } })
  ].join("\n");
  assert.equal(extractCodexFallbackText(lines), "final");
});

test("extractCodexFallbackText reads the newer item.completed agent_message shape", () => {
  const lines = [
    JSON.stringify({ type: "thread.started", thread_id: "t" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } })
  ].join("\n");
  assert.equal(extractCodexFallbackText(lines), "hello");
});

test("extractCodexUsage reads a turn.completed usage block", () => {
  const usage = extractCodexUsage(
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 7, output_tokens: 8 } })
  );
  assert.equal(usage.input_tokens, 7);
  assert.equal(usage.output_tokens, 8);
  assert.equal(usage.total_tokens, 15);
});

test("extractCodexError surfaces the last error / turn.failed message", () => {
  const lines = [
    JSON.stringify({ type: "error", message: "transient" }),
    JSON.stringify({ type: "turn.failed", error: { message: "model not supported" } })
  ].join("\n");
  assert.equal(extractCodexError(lines), "model not supported");
});

test("effort maps to each CLI's own vocabulary (matching T3 Code's tiers)", () => {
  assert.equal(claudeEffort("minimal"), "low");
  assert.equal(claudeEffort("medium"), "medium");
  assert.equal(claudeEffort("high"), "high");
  // Only opus-class Claude models accept the top `xhigh` tier; others cap at high.
  assert.equal(claudeEffort("max"), "high");
  assert.equal(claudeEffort("max", "sonnet"), "high");
  assert.equal(claudeEffort("max", "opus"), "xhigh");
  // Codex accepts minimal | low | medium | high | xhigh, so `max` → `xhigh`.
  assert.equal(codexEffort("minimal"), "minimal");
  assert.equal(codexEffort("medium"), "medium");
  assert.equal(codexEffort("max"), "xhigh");
});

test("Claude harness args allow only web tools when node web is enabled", () => {
  assert.deepEqual(claudePrintArgs({ model: "opus", effort: "max", webEnabled: true }), [
    "-p",
    "--safe-mode",
    "--no-session-persistence",
    "--model",
    "opus",
    "--output-format",
    "json",
    "--effort",
    "xhigh",
    "--tools",
    "WebSearch WebFetch",
    "--allowedTools",
    "WebSearch WebFetch"
  ]);
});

test("Claude harness args disable built-in tools when node web is off", () => {
  assert.deepEqual(claudePrintArgs({ model: "sonnet", webEnabled: false }), [
    "-p",
    "--safe-mode",
    "--no-session-persistence",
    "--model",
    "sonnet",
    "--output-format",
    "json",
    "--tools",
    ""
  ]);
});

test("parseClaudeCliCapabilities reads flag support from --help output", () => {
  const modern = parseClaudeCliCapabilities(
    [
      "Options:",
      "  --allowedTools, --allowed-tools <tools...>  Allow tools",
      "  --effort <level>  Effort level",
      "  --no-session-persistence  Disable session persistence",
      "  --safe-mode  Disable customizations",
      "  --tools <tools...>  Available built-in tools"
    ].join("\n")
  );
  assert.deepEqual(modern, FULL_CLAUDE_CLI_CAPABILITIES);

  const older = parseClaudeCliCapabilities(
    ["Options:", "  --allowedTools <tools...>  Allow tools", "  --model <model>  Model"].join("\n")
  );
  assert.deepEqual(older, {
    safeMode: false,
    noSessionPersistence: false,
    effort: false,
    tools: false,
    allowedTools: true
  });
});

test("Claude harness args degrade per flag on an older CLI", () => {
  const olderCaps = {
    safeMode: false,
    noSessionPersistence: true,
    effort: false,
    tools: false,
    allowedTools: true
  };

  // Web on: unsupported hardening flags are dropped, web tools stay approved.
  assert.deepEqual(claudePrintArgs({ model: "opus", effort: "max", webEnabled: true }, olderCaps), [
    "-p",
    "--no-session-persistence",
    "--model",
    "opus",
    "--output-format",
    "json",
    "--allowedTools",
    "WebSearch WebFetch"
  ]);

  // Web off with no --tools support: nothing is approved, so print mode's
  // default-deny keeps the run tool-free.
  assert.deepEqual(claudePrintArgs({ model: "sonnet", webEnabled: false }, olderCaps), [
    "-p",
    "--no-session-persistence",
    "--model",
    "sonnet",
    "--output-format",
    "json"
  ]);
});

test("claudeCliWarnings names every missing flag and stays silent on full support", () => {
  assert.deepEqual(claudeCliWarnings(FULL_CLAUDE_CLI_CAPABILITIES, "claude"), []);

  const warnings = claudeCliWarnings(
    { safeMode: false, noSessionPersistence: true, effort: false, tools: false, allowedTools: true },
    "/usr/local/bin/claude"
  );
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /--tools/);
  assert.match(warnings[0], /FUSION_CLAUDE_CODE_COMMAND/);
  assert.match(warnings[1], /--safe-mode/);
  assert.match(warnings[2], /--effort/);
});

test("Codex harness args explicitly follow the node web toggle", () => {
  assert.deepEqual(codexExecArgs({ model: "gpt-5.5", effort: "high", webEnabled: true, outputFile: "/tmp/out.txt" }), [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "-m",
    "gpt-5.5",
    "-c",
    "model_reasoning_effort=high",
    "-c",
    "tools.web_search=true",
    "-s",
    "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "--json",
    "-o",
    "/tmp/out.txt",
    "-"
  ]);

  assert.deepEqual(codexExecArgs({ webEnabled: false, outputFile: "/tmp/out.txt" }), [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "-c",
    "tools.web_search=false",
    "-s",
    "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "--json",
    "-o",
    "/tmp/out.txt",
    "-"
  ]);
});

test(
  "spawnCapture kills the CLI process group on timeout",
  { skip: process.platform === "win32" },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "fusion-spawn-capture-"));
    const childPidFile = join(directory, "child.pid");
    const script = join(directory, "fake-cli.mjs");

    writeFileSync(
      script,
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "writeFileSync(process.env.CHILD_PID_FILE, String(child.pid));",
        "setInterval(() => {}, 1000);"
      ].join("\n")
    );

    try {
      const result = await spawnCapture(process.execPath, [script], {
        cwd: directory,
        env: { ...process.env, CHILD_PID_FILE: childPidFile },
        input: "",
        timeoutMs: 250
      });

      assert.equal(result.timedOut, true);
      const childPid = Number(readFileSync(childPidFile, "utf8"));
      assert.ok(Number.isInteger(childPid) && childPid > 0);
      assert.equal(await eventuallyProcessGone(childPid), true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
);
