import assert from "node:assert/strict";
import test from "node:test";

import {
  baseSystemPrompt,
  fusionOuterSystemPrompt,
  judgePrompt,
  panelSystemPrompt,
  promptFromMessages,
  promptWithContext,
  synthPrompt
} from "../src/lib/fusion/prompts.ts";
import type { PanelResponse } from "../src/lib/fusion/types.ts";

test("prompt context keeps the current user turn separate from prior transcript", () => {
  const current = promptFromMessages(
    [
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Follow up" }
    ]
  );
  const modelPrompt = promptWithContext(
    [
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" }
    ],
    current
  );

  assert.equal(current, "Follow up");
  assert.match(modelPrompt, /Conversation context from previous turns:/);
  assert.match(modelPrompt, /assistant: First answer/);
  assert.match(modelPrompt, /Current user request:\nFollow up/);
});

test("prompt context normalizes OpenAI text content parts", () => {
  const current = promptFromMessages([
    {
      role: "developer",
      content: [{ type: "text", text: "Prefer concise answers." }]
    },
    {
      role: "user",
      content: [
        { type: "text", text: "Read the plan." },
        { type: "text", text: "Then list the risks." }
      ]
    }
  ]);
  const modelPrompt = promptWithContext(
    [
      {
        role: "developer",
        content: [{ type: "text", text: "Prefer concise answers." }]
      }
    ],
    current
  );

  assert.equal(current, "Read the plan.\nThen list the risks.");
  assert.match(modelPrompt, /developer: Prefer concise answers/);
  assert.doesNotMatch(modelPrompt, /\{"type":"text"/);
});

test("prompt context preserves client tool calls and tool results as evidence", () => {
  const current = promptFromMessages([
    { role: "user", content: "Read README.md" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_readme",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ path: "README.md" })
          }
        }
      ]
    },
    {
      role: "tool",
      tool_call_id: "call_readme",
      name: "read_file",
      content: "# Fusion\n\nSetup starts with npm install."
    }
  ]);
  const modelPrompt = promptWithContext(
    [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_readme",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "README.md" })
            }
          }
        ]
      },
      {
        role: "tool",
        tool_call_id: "call_readme",
        name: "read_file",
        content: "# Fusion\n\nSetup starts with npm install."
      }
    ],
    current
  );

  assert.equal(current, "Read README.md");
  assert.match(modelPrompt, /tool_calls:/);
  assert.match(modelPrompt, /client tool result \(name=read_file tool_call_id=call_readme\):/);
  assert.match(modelPrompt, /Setup starts with npm install/);
});

test("prompt context preserves multi-step client tool loop ordering", () => {
  const modelPrompt = promptWithContext(
    [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_readme",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "README.md" })
            }
          }
        ]
      },
      {
        role: "tool",
        tool_call_id: "call_readme",
        name: "read_file",
        content: "# Fusion"
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_package",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "package.json" })
            }
          }
        ]
      },
      {
        role: "tool",
        tool_call_id: "call_package",
        name: "read_file",
        content: "{\"scripts\":{\"verify\":\"npm run verify\"}}"
      }
    ],
    "Summarize setup."
  );

  const readmeCall = modelPrompt.indexOf("call_readme");
  const readmeResult = modelPrompt.indexOf("tool_call_id=call_readme");
  const packageCall = modelPrompt.indexOf("call_package");
  const packageResult = modelPrompt.indexOf("tool_call_id=call_package");

  assert.ok(readmeCall >= 0);
  assert.ok(readmeCall < readmeResult);
  assert.ok(readmeResult < packageCall);
  assert.ok(packageCall < packageResult);
  assert.match(modelPrompt, /Client tool results in conversation context|client tool result/);
});

function restoreSystemPrompt(value: string | undefined) {
  if (value === undefined) {
    delete process.env.FUSION_SYSTEM_PROMPT;
  } else {
    process.env.FUSION_SYSTEM_PROMPT = value;
  }
}

function fixtureResponse(): PanelResponse {
  return {
    model: "test/model",
    role: "reviewer",
    content: "Looks viable.",
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2
    },
    sources: [],
    latency_ms: 1
  };
}

test("system prompt falls back when env value is empty", () => {
  const previous = process.env.FUSION_SYSTEM_PROMPT;

  try {
    delete process.env.FUSION_SYSTEM_PROMPT;
    assert.match(baseSystemPrompt(), /You are OpenFusion/);

    process.env.FUSION_SYSTEM_PROMPT = "   ";
    assert.match(baseSystemPrompt(), /You are OpenFusion/);
  } finally {
    restoreSystemPrompt(previous);
  }
});

test("configured system prompt is applied to panel, judge, synthesis, and outer prompts", () => {
  const previous = process.env.FUSION_SYSTEM_PROMPT;
  process.env.FUSION_SYSTEM_PROMPT = "Custom public Fusion behavior contract.";

  try {
    const response = fixtureResponse();

    assert.equal(baseSystemPrompt(), "Custom public Fusion behavior contract.");
    assert.match(panelSystemPrompt(), /Custom public Fusion behavior contract/);
    assert.match(judgePrompt("Audit this.", [response]), /Custom public Fusion behavior contract/);
    assert.match(synthPrompt("Audit this.", [response]), /Custom public Fusion behavior contract/);
    assert.match(fusionOuterSystemPrompt(), /Custom public Fusion behavior contract/);
  } finally {
    restoreSystemPrompt(previous);
  }
});

test("panel prompt is neutral and can omit local tool instructions", () => {
  const prompt = panelSystemPrompt({ localToolsEnabled: false });

  assert.match(prompt, /one independent analysis model/);
  assert.match(prompt, /Do not assume access to other panel responses/);
  assert.match(prompt, /Use available tools when the task needs current facts/);
  assert.doesNotMatch(prompt, /pragmatic architect/);
  assert.doesNotMatch(prompt, /skeptical reviewer/);
  assert.doesNotMatch(prompt, /localList/);
  assert.match(panelSystemPrompt(), /localList/);
});

test("judge prompt compares panel responses without becoming the final answer", () => {
  const prompt = judgePrompt("Which model answer is safest?", [
    {
      ...fixtureResponse(),
      model: "alpha",
      content: "Use the primary source."
    },
    {
      ...fixtureResponse(),
      model: "beta",
      content: "Rely on memory."
    }
  ]);

  assert.match(prompt, /Compare them, do not merge them/);
  assert.match(prompt, /Return structured analysis only; do not write the final answer/);
  assert.match(prompt, /consensus, contradictions, partial coverage, unique insights, and blind spots/);
  assert.match(prompt, /Use available tools to verify important disputed/);
  assert.match(prompt, /Do not vote or average/);
  assert.match(prompt, /"model": "alpha"/);
  assert.match(prompt, /"model": "beta"/);
});

test("synthesis prompt handles optional judge analysis honestly", () => {
  const prompt = synthPrompt("Answer from the council.", [fixtureResponse()]);

  assert.match(prompt, /from the panel responses and, when present, the judge analysis/);
  assert.match(prompt, /If judge analysis is null/);
  assert.match(prompt, /Do not imply that a judge ran/);
  assert.match(prompt, /By default, do not go beyond the prior work with fresh research/);
  assert.match(prompt, /Judge analysis:\nnull/);
});

test("public prompt templates avoid em and en dashes", () => {
  const response = fixtureResponse();
  const prompts = [
    baseSystemPrompt(),
    panelSystemPrompt(),
    judgePrompt("Audit this.", [response]),
    synthPrompt("Audit this.", [response]),
    fusionOuterSystemPrompt()
  ];

  for (const prompt of prompts) {
    assert.doesNotMatch(prompt, /[—–]/);
  }
});

test("outer prompt reflects per-request Fusion disablement", () => {
  assert.match(
    fusionOuterSystemPrompt({ fusionEnabled: false }),
    /Fusion server tool is disabled/
  );
});
