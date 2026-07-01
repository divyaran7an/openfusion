import { handleRunCreate, handleRunsList } from "@/lib/fusion/run-handlers";
import { runFusion } from "@/lib/fusion/orchestrator";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  return handleRunsList(request);
}

export async function POST(request: Request) {
  return handleRunCreate(request, { runner: runFusion });
}
