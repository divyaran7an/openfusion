import type { ToolSet } from "ai";
import { z } from "zod";
import type { WebFetchConfig, WebSearchConfig } from "./schemas.ts";

export type OpenRouterServerTool = {
  type: "openrouter:web_search" | "openrouter:web_fetch";
  parameters?: Record<string, unknown>;
};

function compactRecord(input: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  );
}

export function openRouterServerToolsFor(
  web?: { enabled?: boolean; search?: WebSearchConfig; fetch?: WebFetchConfig }
): OpenRouterServerTool[] {
  if (!web?.enabled) {
    return [];
  }

  const searchParameters = compactRecord({
    engine: web.search?.engine,
    max_results: web.search?.max_results,
    max_total_results: web.search?.max_total_results,
    search_context_size: web.search?.search_context_size,
    allowed_domains: web.search?.allowed_domains,
    excluded_domains: web.search?.excluded_domains
  });
  const fetchParameters = compactRecord({
    engine: web.fetch?.engine,
    max_uses: web.fetch?.max_uses,
    max_content_tokens: web.fetch?.max_content_tokens,
    allowed_domains: web.fetch?.allowed_domains,
    blocked_domains: web.fetch?.blocked_domains
  });

  return [
    {
      type: "openrouter:web_search",
      ...(Object.keys(searchParameters).length > 0 ? { parameters: searchParameters } : {})
    },
    {
      type: "openrouter:web_fetch",
      ...(Object.keys(fetchParameters).length > 0 ? { parameters: fetchParameters } : {})
    }
  ];
}

function openRouterProviderTool(
  tool: OpenRouterServerTool,
  name: string
): ToolSet[string] {
  return {
    type: "provider",
    id: tool.type.replace(":", ".") as `${string}.${string}`,
    name,
    args: tool.parameters ?? {},
    inputSchema: z.object({})
  } as unknown as ToolSet[string];
}

export function openRouterProviderToolsFor(
  web?: { enabled?: boolean; search?: WebSearchConfig; fetch?: WebFetchConfig }
): ToolSet | undefined {
  const tools = openRouterServerToolsFor(web);
  if (tools.length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    tools.map((tool) => [
      tool.type === "openrouter:web_search"
        ? "openRouterWebSearch"
        : "openRouterWebFetch",
      openRouterProviderTool(
        tool,
        tool.type === "openrouter:web_search"
          ? "openRouterWebSearch"
          : "openRouterWebFetch"
      )
    ])
  ) as ToolSet;
}
