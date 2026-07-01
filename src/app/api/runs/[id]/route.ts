import { handleRunGet } from "@/lib/fusion/run-handlers";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  return handleRunGet(request, id);
}
