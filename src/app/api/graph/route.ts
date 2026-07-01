import { FusionGraphSchema, validateGraph } from "@/lib/fusion/graph";
import { getActiveGraph, saveActiveGraph } from "@/lib/fusion/graph-store";

export const runtime = "nodejs";

export function GET() {
  const graph = getActiveGraph();
  return Response.json({ graph, validation: validateGraph(graph) });
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: { type: "bad_request", message: "Body must be JSON." } },
      { status: 400 }
    );
  }

  const parsed = FusionGraphSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        error: {
          type: "invalid_graph",
          message: parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "graph"}: ${issue.message}`)
            .join("; ")
        }
      },
      { status: 400 }
    );
  }

  const graph = saveActiveGraph(parsed.data);
  return Response.json({ graph, validation: validateGraph(graph) });
}
