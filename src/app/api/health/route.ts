import { NextResponse } from "next/server";
import { isApiAuthRequired } from "@/lib/fusion/auth";
import { healthPayload } from "@/lib/fusion/catalog";
import { getActiveGraph } from "@/lib/fusion/graph-store";
import { harnessProviders } from "@/lib/fusion/harness";
import {
  hasLocalTools,
  hasWebFetchTool,
  hasParallelExtractCredentials,
  hasWebCredentials,
  hasOpenRouterCredentials,
  probeGatewayConnectivity,
  probeOpenRouterConnectivity
} from "@/lib/fusion/provider";
import { storeMode } from "@/lib/fusion/store";

export const runtime = "nodejs";

export async function GET(request: Request) {
  // Default health is cheap (an auth-only credits check) so uptime monitors and
  // liveness probes never trigger a billable call. The studio asks for `?probe=deep`
  // to additionally catch a per-key spend cap via a tiny generation against a
  // model the graph actually uses. Both are cached + de-duped inside the probe.
  const deep = new URL(request.url).searchParams.get("probe") === "deep";
  const graph = getActiveGraph();
  const gatewayModel = graph.nodes.find((node) => node.source === "gateway")?.model?.trim();
  const openRouterModel = graph.nodes.find((node) => node.source === "openrouter")?.model?.trim();
  const [gateway, openrouter] = await Promise.all([
    probeGatewayConnectivity({ model: gatewayModel || undefined, deep }),
    probeOpenRouterConnectivity({ model: openRouterModel || undefined, deep })
  ]);

  return NextResponse.json(
    healthPayload({
      gateway: gateway.ok,
      gatewayReason: gateway.ok ? undefined : gateway.reason,
      gatewayWebSearch: gateway.ok && hasWebCredentials(),
      openrouter: openrouter.ok,
      openrouterReason: openrouter.ok ? undefined : openrouter.reason,
      openrouterWebSearch: openrouter.ok && hasOpenRouterCredentials(),
      webFetch: hasWebFetchTool(),
      parallelExtract: hasParallelExtractCredentials(),
      localTools: hasLocalTools(),
      harnesses: harnessProviders(),
      store: storeMode(),
      authRequired: isApiAuthRequired()
    })
  );
}
