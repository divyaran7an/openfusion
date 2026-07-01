import { NextResponse } from "next/server";
import { getStoredGatewayKey, maskKey, setStoredGatewayKey } from "@/lib/fusion/credentials";

export const runtime = "nodejs";

// Report whether a key is configured, where it came from, and a MASKED preview
// (last 4 chars) so the studio can show that a key is set — never the key itself.
// No CORS is attached to /api/*, so this stays same-origin (the studio).
function maskGatewayKey(): string | null {
  const key = getStoredGatewayKey() || process.env.AI_GATEWAY_API_KEY || "";
  return key ? maskKey(key) : null;
}

function credentialStatus() {
  const stored = Boolean(getStoredGatewayKey());
  const env = Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);
  return {
    gateway: {
      configured: stored || env,
      source: stored ? "studio" : env ? "environment" : "none",
      masked: maskGatewayKey()
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

  const key = (body as { gateway_api_key?: unknown }).gateway_api_key;
  if (typeof key !== "string") {
    return badRequest("Expected a string `gateway_api_key` (send an empty string to clear).");
  }

  setStoredGatewayKey(key);
  return NextResponse.json(credentialStatus());
}
