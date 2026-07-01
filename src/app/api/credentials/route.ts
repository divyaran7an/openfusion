import { NextResponse } from "next/server";
import {
  getStoredGatewayKey,
  getStoredOpenRouterKey,
  maskKey,
  setStoredGatewayKey,
  setStoredOpenRouterKey
} from "@/lib/fusion/credentials";

export const runtime = "nodejs";

// Report whether a key is configured, where it came from, and a MASKED preview
// (last 4 chars) so the studio can show that a key is set — never the key itself.
// No CORS is attached to /api/*, so this stays same-origin (the studio).
function maskGatewayKey(): string | null {
  const key = getStoredGatewayKey() || process.env.AI_GATEWAY_API_KEY || "";
  return key ? maskKey(key) : null;
}

function maskOpenRouterKey(): string | null {
  const key = getStoredOpenRouterKey() || process.env.OPENROUTER_API_KEY || "";
  return key ? maskKey(key) : null;
}

function credentialStatus() {
  const stored = Boolean(getStoredGatewayKey());
  const env = Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);
  const openRouterStored = Boolean(getStoredOpenRouterKey());
  const openRouterEnv = Boolean(process.env.OPENROUTER_API_KEY);
  return {
    gateway: {
      configured: stored || env,
      source: stored ? "studio" : env ? "environment" : "none",
      masked: maskGatewayKey()
    },
    openrouter: {
      configured: openRouterStored || openRouterEnv,
      source: openRouterStored ? "studio" : openRouterEnv ? "environment" : "none",
      masked: maskOpenRouterKey()
    }
  };
}

function badRequest(message: string) {
  return NextResponse.json(
    { error: { message, type: "invalid_request_error" } },
    { status: 400 }
  );
}

export function GET() {
  return NextResponse.json(credentialStatus());
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid JSON body.");
  }

  const value = body as { gateway_api_key?: unknown; openrouter_api_key?: unknown };
  const hasGateway = "gateway_api_key" in value;
  const hasOpenRouter = "openrouter_api_key" in value;

  if (!hasGateway && !hasOpenRouter) {
    return badRequest("Expected `gateway_api_key` or `openrouter_api_key`.");
  }
  if (hasGateway && typeof value.gateway_api_key !== "string") {
    return badRequest("Expected a string `gateway_api_key` (send an empty string to clear).");
  }
  if (hasOpenRouter && typeof value.openrouter_api_key !== "string") {
    return badRequest("Expected a string `openrouter_api_key` (send an empty string to clear).");
  }

  if (hasGateway) {
    setStoredGatewayKey(value.gateway_api_key as string);
  }
  if (hasOpenRouter) {
    setStoredOpenRouterKey(value.openrouter_api_key as string);
  }

  return NextResponse.json(credentialStatus());
}
