import { requireApiAuth } from "@/lib/fusion/auth";
import { getComparison } from "@/lib/fusion/comparison-store";
import { jsonError } from "@/lib/fusion/http-errors";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const authError = requireApiAuth(request);
  if (authError) return authError;

  const { id } = await context.params;
  const comparison = getComparison(id);
  if (!comparison) {
    return jsonError("not_found", `No comparison exists with id ${id}.`, 404);
  }

  return Response.json(comparison);
}
