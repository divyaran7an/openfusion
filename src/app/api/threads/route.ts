import { handleThreadsList } from "@/lib/fusion/thread-handlers";

export const runtime = "nodejs";

export function GET(request: Request) {
  return handleThreadsList(request);
}
