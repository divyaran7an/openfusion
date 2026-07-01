import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSupportedClientTools,
  clientFunctionTools,
  fusionOverrideFromOpenAIRequest,
  hasClientToolTranscript,
  shouldUseAgenticFusion
} from "../src/lib/fusion/fusion-config.ts";

test("fusion override accepts OpenRouter plugin configuration", () => {
  const override = fusionOverrideFromOpenAIRequest({
    model: "openrouter/fusion",
    messages: [{ role: "user", content: "compare these options" }],
    plugins: [
      {
        id: "fusion",
        analysis_models: [
          "~anthropic/claude-opus-latest",
          "~openai/gpt-latest",
          "~google/gemini-pro-latest"
        ],
        model: "~openai/gpt-latest",
        max_tool_calls: 12,
        temperature: 0.3
      }
    ]
  });

  assert.deepEqual(override?.panel_models, [
    "~anthropic/claude-opus-latest",
    "~openai/gpt-latest",
    "~google/gemini-pro-latest"
  ]);
  assert.equal(override?.judge_model, "~openai/gpt-latest");
  assert.equal(override?.max_tool_calls, 12);
  assert.equal(override?.temperature, 0.3);
  assert.equal(override?.strict, true);
});

test("fusion override maps OpenRouter Fusion plugin presets", () => {
  const high = fusionOverrideFromOpenAIRequest({
    model: "openrouter/fusion",
    messages: [{ role: "user", content: "compare these options" }],
    plugins: [
      {
        id: "fusion",
        preset: "general-high"
      }
    ]
  });
  const budget = fusionOverrideFromOpenAIRequest({
    model: "openrouter/fusion",
    messages: [{ role: "user", content: "compare these options" }],
    plugins: [
      {
        id: "fusion",
        preset: "general-budget"
      }
    ]
  });
  const fast = fusionOverrideFromOpenAIRequest({
    model: "openrouter/fusion",
    messages: [{ role: "user", content: "compare these options" }],
    plugins: [
      {
        id: "fusion",
        preset: "general-fast"
      }
    ]
  });

  // OpenRouter tier semantics: high = strongest distinct families.
  assert.deepEqual(high?.panel_models, [
    "anthropic/claude-opus-4.8",
    "openai/gpt-5.5",
    "google/gemini-3.1-pro-preview"
  ]);
  // budget = a cheaper panel with the same frontier judge.
  assert.deepEqual(budget?.panel_models, [
    "google/gemini-3.5-flash",
    "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4-flash"
  ]);
  // fast = a latency-homogeneous fast panel.
  assert.deepEqual(fast?.panel_models, [
    "google/gemini-3.5-flash",
    "deepseek/deepseek-v4-flash"
  ]);
  assert.equal(high?.judge_model, "openai/gpt-5.5");
  assert.equal(budget?.judge_model, "openai/gpt-5.5");
  assert.equal(fast?.judge_model, "openai/gpt-5.5");
  assert.equal(high?.strict, true);
  assert.equal(budget?.strict, true);
  assert.equal(fast?.strict, true);
});

test("fusion override rejects unknown preset slugs instead of running defaults", () => {
  assert.throws(
    () =>
      fusionOverrideFromOpenAIRequest({
        model: "openrouter/fusion",
        messages: [{ role: "user", content: "compare these options" }],
        plugins: [
          {
            id: "fusion",
            preset: "coding-high"
          }
        ]
      }),
    /Fusion preset "coding-high" is not supported/
  );
});

test("openrouter fusion alias enables strict Fusion without extra configuration", () => {
  const override = fusionOverrideFromOpenAIRequest({
    model: "openrouter/fusion",
    messages: [{ role: "user", content: "compare these options" }]
  });

  assert.equal(override?.strict, true);
});

test("fusion override accepts OpenRouter plugin disablement", () => {
  const disabled = fusionOverrideFromOpenAIRequest({
    model: "openrouter/fusion",
    messages: [{ role: "user", content: "answer directly" }],
    tool_choice: "required",
    plugins: [
      {
        id: "fusion",
        enabled: false
      }
    ]
  });
  const explicitTool = fusionOverrideFromOpenAIRequest({
    model: "openrouter/fusion",
    messages: [{ role: "user", content: "run the tool" }],
    plugins: [
      {
        id: "fusion",
        enabled: false
      }
    ],
    tools: [
      {
        type: "openrouter:fusion"
      }
    ]
  });

  assert.equal(disabled?.disabled, true);
  assert.equal(disabled?.force, false);
  assert.equal(explicitTool?.disabled, undefined);
  assert.equal(explicitTool?.strict, true);
});

test("agentic fusion routing is limited to OpenRouter-compatible aliases or tools", () => {
  assert.equal(
    shouldUseAgenticFusion({
      model: "openrouter/fusion",
      messages: [{ role: "user", content: "research this" }]
    }),
    true
  );
  assert.equal(
    shouldUseAgenticFusion({
      model: "anthropic/claude-opus-4.8",
      messages: [{ role: "user", content: "research this" }],
      tools: [{ type: "openrouter:fusion" }]
    }),
    true
  );
  assert.equal(
    shouldUseAgenticFusion({
      model: "fusion/fusion-8",
      messages: [{ role: "user", content: "research this" }]
    }),
    false
  );
});

test("fusion override accepts server tool parameters and tool_choice", () => {
  const override = fusionOverrideFromOpenAIRequest({
    model: "fusion/fusion",
    messages: [{ role: "user", content: "review this" }],
    tool_choice: "required",
    reasoning: { effort: "high" },
    tools: [
      {
        type: "openrouter:fusion",
        parameters: {
          analysis_models: ["deepseek/deepseek-v4-pro"],
          model: "openai/gpt-5.5",
          outer_model: "anthropic/claude-opus-4.8",
          max_completion_tokens: 4096
        }
      }
    ]
  });

  assert.deepEqual(override?.panel_models, ["deepseek/deepseek-v4-pro"]);
  assert.equal(override?.judge_model, "openai/gpt-5.5");
  assert.equal(override?.outer_model, "anthropic/claude-opus-4.8");
  assert.equal(override?.max_completion_tokens, 4096);
  assert.deepEqual(override?.reasoning, { effort: "high" });
  assert.equal(override?.force, true);
  assert.equal(override?.strict, true);
});

test("generic required tool choice preserves competing client function tools", () => {
  const withClientTool = fusionOverrideFromOpenAIRequest({
    model: "openrouter/fusion",
    messages: [{ role: "user", content: "inspect the repo" }],
    tools: [
      { type: "openrouter:fusion" },
      {
        type: "function",
        function: {
          name: "read_file"
        }
      }
    ],
    tool_choice: "required"
  });
  const withoutClientTool = fusionOverrideFromOpenAIRequest({
    model: "openrouter/fusion",
    messages: [{ role: "user", content: "research this" }],
    tools: [{ type: "openrouter:fusion" }],
    tool_choice: "required"
  });
  const specificFusion = fusionOverrideFromOpenAIRequest({
    model: "openrouter/fusion",
    messages: [{ role: "user", content: "research this" }],
    tools: [
      { type: "openrouter:fusion" },
      {
        type: "function",
        function: {
          name: "read_file"
        }
      }
    ],
    tool_choice: { type: "openrouter:fusion" }
  });

  assert.equal(withClientTool?.force, undefined);
  assert.equal(withClientTool?.strict, true);
  assert.equal(withoutClientTool?.force, true);
  assert.equal(specificFusion?.force, true);
});

test("fusion override parses OpenRouter web search and fetch server tool parameters", () => {
  const override = fusionOverrideFromOpenAIRequest({
    model: "openrouter/fusion",
    messages: [{ role: "user", content: "research this" }],
    tools: [
      {
        type: "openrouter:web_search",
        parameters: {
          engine: "parallel",
          max_results: 5,
          max_total_results: 8,
          search_context_size: "low",
          max_characters: 12_000,
          allowed_domains: ["openrouter.ai"],
          excluded_domains: ["reddit.com"]
        }
      },
      {
        type: "openrouter:web_fetch",
        parameters: {
          engine: "parallel",
          max_uses: 2,
          max_content_tokens: 4096,
          allowed_domains: ["openrouter.ai"],
          blocked_domains: ["localhost"]
        }
      }
    ]
  });

  assert.equal(override?.web_search?.engine, "parallel");
  assert.equal(override?.web_search?.max_results, 5);
  assert.deepEqual(override?.web_search?.allowed_domains, ["openrouter.ai"]);
  assert.equal(override?.web_fetch?.max_uses, 2);
  assert.equal(override?.web_fetch?.max_content_tokens, 4096);
});

test("client tool validation accepts OpenRouter web server tools as configuration", () => {
  assert.doesNotThrow(() =>
    assertSupportedClientTools({
      model: "openrouter/fusion",
      messages: [{ role: "user", content: "research this" }],
      tools: [
        { type: "openrouter:fusion" },
        {
          type: "openrouter:web_search",
          parameters: { max_results: 3 }
        },
        {
          type: "openrouter:web_fetch",
          parameters: { max_uses: 1 }
        }
      ]
    })
  );
});

test("fusion override rejects oversized analysis panels", () => {
  assert.throws(
    () =>
      fusionOverrideFromOpenAIRequest({
        model: "openrouter/fusion",
        messages: [{ role: "user", content: "review this" }],
        plugins: [
          {
            id: "fusion",
            analysis_models: Array.from({ length: 9 }, (_, index) => `model/${index}`)
          }
        ]
      }),
    /Fusion plugin parameters are invalid/
  );
});

test("client tool validation supports function passthrough through the agentic wrapper", () => {
  assert.doesNotThrow(() =>
    assertSupportedClientTools({
      model: "fusion/fusion",
      messages: [{ role: "user", content: "review this" }],
      tools: [{ type: "openrouter:fusion" }],
      tool_choice: "required"
    })
  );

  assert.doesNotThrow(() =>
    assertSupportedClientTools({
      model: "fusion/fusion-8",
      stream: true,
      messages: [{ role: "user", content: "inspect files" }],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file"
          }
        }
      ],
      tool_choice: {
        type: "function",
        function: {
          name: "read_file"
        }
      }
    })
  );

  assert.equal(
    shouldUseAgenticFusion({
      model: "fusion/fusion-8",
      messages: [{ role: "user", content: "edit files" }],
      tools: [
        {
          type: "function",
          function: {
            name: "edit_file"
          }
        }
      ]
    }),
    true
  );
  assert.equal(
    shouldUseAgenticFusion({
      model: "fusion/fusion-8",
      messages: [{ role: "user", content: "answer without tools" }],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file"
          }
        }
      ],
      tool_choice: "none"
    }),
    false
  );
  assert.equal(
    shouldUseAgenticFusion({
      model: "fusion/fusion-8",
      messages: [{ role: "user", content: "answer without tools" }],
      functions: [
        {
          name: "read_file"
        }
      ],
      function_call: "none"
    }),
    false
  );

  const continuation = {
    model: "fusion/fusion-8",
    messages: [
      { role: "user" as const, content: "Inspect README and package.json." },
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          {
            id: "call_readme",
            type: "function" as const,
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "README.md" })
            }
          }
        ]
      },
      {
        role: "tool" as const,
        tool_call_id: "call_readme",
        name: "read_file",
        content: "# Fusion"
      }
    ]
  };
  assert.equal(hasClientToolTranscript(continuation), true);
  assert.equal(shouldUseAgenticFusion(continuation), true);
  assert.equal(
    shouldUseAgenticFusion({
      ...continuation,
      tool_choice: "none" as const
    }),
    true
  );

  const legacyFunctions = {
    model: "fusion/fusion-8",
    messages: [{ role: "user" as const, content: "inspect files" }],
    functions: [
      {
        name: "read_file",
        description: "Read a file from the client workspace."
      }
    ],
    function_call: {
      name: "read_file"
    }
  };
  assert.doesNotThrow(() => assertSupportedClientTools(legacyFunctions));
  assert.equal(shouldUseAgenticFusion(legacyFunctions), true);

  assert.throws(
    () =>
      assertSupportedClientTools({
        model: "fusion/fusion",
        messages: [{ role: "user", content: "review this" }],
        tool_choice: {
          type: "function",
          function: {
            name: "edit_file"
          }
        }
      }),
    /Unsupported tool_choice/
  );

  assert.throws(
    () =>
      assertSupportedClientTools({
        model: "fusion/fusion",
        messages: [{ role: "user", content: "inspect files" }],
        functions: [
          {
            name: "read_file"
          }
        ],
        function_call: {
          name: "edit_file"
        }
      }),
    /Unsupported tool_choice/
  );

  assert.throws(
    () =>
      assertSupportedClientTools({
        model: "openrouter/fusion",
        messages: [{ role: "user", content: "inspect files" }],
        tools: [
          {
            type: "function",
            function: {
              name: "fusionTool"
            }
          }
        ]
      }),
    /reserved/
  );
});

test("client tool validation rejects malformed OpenAI function tools", () => {
  assert.throws(
    () =>
      assertSupportedClientTools({
        model: "fusion/fusion-8",
        messages: [{ role: "user", content: "inspect files" }],
        tools: [
          {
            type: "function",
            function: {
              description: "Missing a name."
            }
          }
        ]
      }),
    /Invalid OpenAI function tool at tools\[0\].*function.name/
  );
});

test("client tool validation preserves strict OpenAI function metadata", () => {
  const tools = clientFunctionTools({
    model: "fusion/fusion-8",
    messages: [{ role: "user", content: "inspect files" }],
    tools: [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file.",
          strict: true,
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" }
            },
            required: ["path"],
            additionalProperties: false
          }
        }
      }
    ]
  });

  assert.equal(tools[0]?.function.strict, true);
  assert.deepEqual(tools[0]?.function.parameters?.required, ["path"]);
});
