import { requireApiAuth } from "@/lib/fusion/auth";
import { listCouncils, saveCouncil } from "@/lib/fusion/council-store";
import { getActiveGraph } from "@/lib/fusion/graph-store";
import { FusionGraphSchema } from "@/lib/fusion/graph";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const authError = requireApiAuth(request);
  if (authError) return authError;

  return Response.json({
    object: "list",
    data: listCouncils()
  });
}

export async function POST(request: Request) {
  const authError = requireApiAuth(request);
  if (authError) return authError;

  const body = await request.json();
  const graph = body.graph ? FusionGraphSchema.parse(body.graph) : getActiveGraph();
  const saved = saveCouncil({
    name: typeof body.name === "string" && body.name.trim() ? body.name : graph.name,
    description: typeof body.description === "string" ? body.description : undefined,
    graph
  });

  return Response.json(saved, { status: 201 });
}
