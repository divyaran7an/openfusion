import { handleMcpRequest } from "@/lib/fusion/mcp-handler";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  return handleMcpRequest(request);
}

export async function GET(request: Request) {
  return handleMcpRequest(request);
}

export async function DELETE(request: Request) {
  return handleMcpRequest(request);
}
