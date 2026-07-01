import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { localToolsFor } from "../src/lib/fusion/local-tools.ts";

type ToolExecute<TInput, TResult> = (
  input: TInput,
  options: { toolCallId: string; messages: [] }
) => Promise<TResult>;

test("local tools read inside configured roots and deny secret paths", async () => {
  const originalRoots = process.env.FUSION_LOCAL_ROOTS;
  const originalEnabled = process.env.FUSION_LOCAL_TOOLS;
  const root = await mkdtemp(path.join(tmpdir(), "fusion-local-tools-"));

  process.env.FUSION_LOCAL_ROOTS = root;
  process.env.FUSION_LOCAL_TOOLS = "1";

  try {
    const visibleFile = path.join(root, "notes.txt");
    const secretFile = path.join(root, ".env");
    await writeFile(visibleFile, "alpha beta gamma\n", "utf8");
    await writeFile(secretFile, "AI_GATEWAY_API_KEY=secret\n", "utf8");

    const tools = localToolsFor(true);
    assert.ok(tools);

    const read = tools.localRead.execute as unknown as ToolExecute<
      { path: string; maxBytes: number },
      { ok: boolean; text?: string; error?: string }
    >;
    const searchTool = tools.localSearch.execute as unknown as ToolExecute<
      { path: string; query: string; maxMatches: number },
      { ok: boolean; count?: number; error?: string }
    >;

    const readVisible = await read(
      { path: visibleFile, maxBytes: 4_000 },
      { toolCallId: "test-read-visible", messages: [] }
    );
    assert.equal(readVisible.ok, true);
    assert.match(readVisible.text ?? "", /alpha beta gamma/);

    const readSecret = await read(
      { path: secretFile, maxBytes: 4_000 },
      { toolCallId: "test-read-secret", messages: [] }
    );
    assert.equal(readSecret.ok, false);
    assert.match(readSecret.error ?? "", /Access denied/);

    const search = await searchTool(
      { path: root, query: "AI_GATEWAY_API_KEY", maxMatches: 10 },
      { toolCallId: "test-search", messages: [] }
    );
    assert.equal(search.ok, true);
    assert.equal(search.count, 0);
  } finally {
    if (originalRoots === undefined) {
      delete process.env.FUSION_LOCAL_ROOTS;
    } else {
      process.env.FUSION_LOCAL_ROOTS = originalRoots;
    }

    if (originalEnabled === undefined) {
      delete process.env.FUSION_LOCAL_TOOLS;
    } else {
      process.env.FUSION_LOCAL_TOOLS = originalEnabled;
    }
  }
});
