import assert from "node:assert/strict";
import test from "node:test";

import {
  harnessClientToolInstruction,
  parseHarnessClientToolCalls
} from "../src/lib/fusion/provider.ts";
import type { OpenAIClientFunctionTool } from "../src/lib/fusion/schemas.ts";

const tools: OpenAIClientFunctionTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from the caller workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_file"
    }
  }
];

test("harness client tool instruction is omitted when tools are disabled", () => {
  assert.equal(harnessClientToolInstruction(tools, "none"), undefined);
  assert.equal(harnessClientToolInstruction(undefined, "auto"), undefined);
});

test("harness client tool instruction narrows forced function choices", () => {
  const instruction = harnessClientToolInstruction(tools, {
    type: "function",
    function: { name: "read_file" }
  });

  assert.ok(instruction);
  assert.match(instruction, /read_file/);
  assert.doesNotMatch(instruction, /edit_file/);
});

test("parseHarnessClientToolCalls translates the agreed JSON shape", () => {
  const calls = parseHarnessClientToolCalls(
    JSON.stringify({
      tool_call: {
        name: "read_file",
        arguments: { path: "README.md" }
      }
    }),
    tools,
    "auto"
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.type, "function");
  assert.equal(calls[0]?.function.name, "read_file");
  assert.equal(calls[0]?.function.arguments, JSON.stringify({ path: "README.md" }));
});

test("parseHarnessClientToolCalls ignores tools the client did not offer", () => {
  const calls = parseHarnessClientToolCalls(
    JSON.stringify({
      tool_call: {
        name: "delete_everything",
        arguments: {}
      }
    }),
    tools,
    "auto"
  );

  assert.deepEqual(calls, []);
});

test("parseHarnessClientToolCalls honors forced function choice", () => {
  const calls = parseHarnessClientToolCalls(
    JSON.stringify({
      tool_calls: [
        {
          name: "edit_file",
          arguments: { path: "README.md" }
        }
      ]
    }),
    tools,
    { type: "function", function: { name: "read_file" } }
  );

  assert.deepEqual(calls, []);
});
