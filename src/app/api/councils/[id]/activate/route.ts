import { requireApiAuth } from "@/lib/fusion/auth";
import { activateCouncil } from "@/lib/fusion/council-store";
import { jsonError } from "@/lib/fusion/http-errors";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const authError = requireApiAuth(request);
  if (authError) return authError;

  const { id } = await context.params;
  const graph = activateCouncil(id);
  if (!graph) {
    return jsonError("not_found", `No council exists with id ${id}.`, 404);
  }

  return Response.json({ object: "fusion.council.activation", graph });
}
