import { handleOpenAIChatCompletion } from "@/lib/fusion/openai-handler";
import { corsPreflight, withCors } from "@/lib/fusion/cors";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  return withCors(await handleOpenAIChatCompletion(request));
}

export function OPTIONS() {
  return corsPreflight();
}
