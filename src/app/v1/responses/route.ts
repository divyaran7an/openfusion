import { handleOpenAIResponse } from "@/lib/fusion/responses-handler";
import { corsPreflight, withCors } from "@/lib/fusion/cors";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  return withCors(await handleOpenAIResponse(request));
}

export function OPTIONS() {
  return corsPreflight();
}
