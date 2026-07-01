import assert from "node:assert/strict";
import test from "node:test";

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, tool } from "ai";
import { z } from "zod";

import {
  openRouterProviderToolsFor,
  openRouterServerToolsFor
} from "../src/lib/fusion/openrouter-tools.ts";

test("OpenRouter server tools are disabled when web is off", () => {
  assert.deepEqual(openRouterServerToolsFor({ enabled: false }), []);
  assert.deepEqual(openRouterServerToolsFor(), []);
});

test("OpenRouter server tools use current openrouter:* tool payloads", () => {
  assert.deepEqual(
    openRouterServerToolsFor({
      enabled: true,
      search: {
        engine: "parallel",
        max_results: 5,
        max_total_results: 20,
        search_context_size: "medium",
        allowed_domains: ["openrouter.ai"],
        excluded_domains: ["example.com"]
      },
      fetch: {
        engine: "openrouter",
        max_uses: 3,
        max_content_tokens: 4096,
        allowed_domains: ["docs.openrouter.ai"],
        blocked_domains: ["internal.example.com"]
      }
    }),
    [
      {
        type: "openrouter:web_search",
        parameters: {
          engine: "parallel",
          max_results: 5,
          max_total_results: 20,
          search_context_size: "medium",
          allowed_domains: ["openrouter.ai"],
          excluded_domains: ["example.com"]
        }
      },
      {
        type: "openrouter:web_fetch",
        parameters: {
          engine: "openrouter",
          max_uses: 3,
          max_content_tokens: 4096,
          allowed_domains: ["docs.openrouter.ai"],
          blocked_domains: ["internal.example.com"]
        }
      }
    ]
  );
});

test("OpenRouter server tools preserve Perplexity search engine", () => {
  assert.deepEqual(
    openRouterServerToolsFor({
      enabled: true,
      search: { engine: "perplexity", max_results: 3 }
    })[0],
    {
      type: "openrouter:web_search",
      parameters: {
        engine: "perplexity",
        max_results: 3
      }
    }
  );
});

test("OpenRouter AI SDK sends server tools without dropping function tools", async () => {
  let body: Record<string, unknown> | undefined;
  const provider = createOpenRouter({
    apiKey: "test-key",
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          id: "gen_test",
          object: "chat.completion",
          created: 1_782_000_000,
          model: "openai/gpt-5.5",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop"
            }
          ],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
  });

  await generateText({
    model: provider.chat("openai/gpt-5.5", { usage: { include: true } }),
    prompt: "ping",
    maxOutputTokens: 4,
    tools: {
      localRead: tool({
        description: "Read a local file",
        inputSchema: z.object({ path: z.string() }),
        execute: async () => "ok"
      }),
      ...openRouterProviderToolsFor({
        enabled: true,
        search: { engine: "parallel", max_results: 2 },
        fetch: { max_uses: 3, max_content_tokens: 4096 }
      })
    },
    toolChoice: "auto",
    providerOptions: {
      openrouter: {
        reasoning: { effort: "high" }
      }
    }
  });

  assert.deepEqual(body?.tools, [
    {
      type: "function",
      function: {
        name: "localRead",
        description: "Read a local file",
        parameters: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    {
      type: "openrouter:web_search",
      engine: "parallel",
      max_results: 2
    },
    {
      type: "openrouter:web_fetch",
      max_uses: 3,
      max_content_tokens: 4096
    }
  ]);
  assert.equal(body?.tool_choice, "auto");
  assert.deepEqual(body?.reasoning, { effort: "high" });
  assert.deepEqual(body?.usage, { include: true });
});
