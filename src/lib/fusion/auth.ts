import { timingSafeEqual } from "node:crypto";

function configuredKeys() {
  return (process.env.FUSION_API_KEYS ?? "")
    .split(/[\n,]/)
    .map((key) => key.trim())
    .filter(Boolean);
}

export function isApiAuthRequired() {
  return configuredKeys().length > 0;
}

export function extractBearerToken(request: Request) {
  const authorization = request.headers.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice("bearer ".length).trim();
  }

  return request.headers.get("x-fusion-api-key")?.trim();
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function isAuthorized(request: Request) {
  const keys = configuredKeys();
  if (keys.length === 0) {
    return true;
  }

  const token = extractBearerToken(request);
  if (!token) {
    return false;
  }

  return keys.some((key) => safeEqual(token, key));
}

export function unauthorizedResponse() {
  return Response.json(
    {
      // Same envelope shape as /v1/chat/completions, so a standard OpenAI SDK
      // client parses the 401 identically (message · type · param · code).
      error: {
        message:
          "Missing or invalid Fusion API key. Send Authorization: Bearer <key> or x-fusion-api-key.",
        type: "unauthorized",
        param: null,
        code: null
      }
    },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Bearer realm="Fusion API"'
      }
    }
  );
}

export function requireApiAuth(request: Request) {
  if (isAuthorized(request)) {
    return undefined;
  }

  return unauthorizedResponse();
}
