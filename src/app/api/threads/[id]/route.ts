import { handleThreadGet } from "@/lib/fusion/thread-handlers";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  return handleThreadGet(request, id);
}
