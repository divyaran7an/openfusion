import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/fusion/auth";
import { modelRecords } from "@/lib/fusion/catalog";
import { corsPreflight, withCors } from "@/lib/fusion/cors";
import { hasWebFetchTool } from "@/lib/fusion/provider";

export const runtime = "nodejs";

export function GET(request: Request) {
  const authError = requireApiAuth(request);
  if (authError) {
    return withCors(authError);
  }

  return withCors(
    NextResponse.json(
      modelRecords({
        webFetchAvailable: hasWebFetchTool()
      })
    )
  );
}

export function OPTIONS() {
  return corsPreflight();
}
