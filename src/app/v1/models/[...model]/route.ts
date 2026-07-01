import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/fusion/auth";
import { modelRecord } from "@/lib/fusion/catalog";
import { corsPreflight, withCors } from "@/lib/fusion/cors";
import { hasWebFetchTool } from "@/lib/fusion/provider";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ model: string[] }> }
) {
  const authError = requireApiAuth(request);
  if (authError) {
    return withCors(authError);
  }

  const { model } = await context.params;
  return withCors(
    NextResponse.json(
      modelRecord(model.join("/"), {
        webFetchAvailable: hasWebFetchTool()
      })
    )
  );
}

export function OPTIONS() {
  return corsPreflight();
}
