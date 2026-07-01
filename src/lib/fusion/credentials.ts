import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * Local credential store for keys the user sets from the studio, so connecting a
 * provider never means editing a file and restarting the server.
 *
 * Hosted provider keys live next to the graph under `.fusion/` (gitignored),
 * written owner-only (0600). This is the same trust boundary as `.env.local`,
 * but editable live. Override the location with `FUSION_DATA_DIR`.
 */

const CredentialsSchema = z.object({
  gateway_api_key: z.string().optional(),
  openrouter_api_key: z.string().optional()
});
type Credentials = z.infer<typeof CredentialsSchema>;

function credentialsPath() {
  const dir = process.env.FUSION_DATA_DIR?.trim() || join(process.cwd(), ".fusion");
  return { dir, file: join(dir, "credentials.json") };
}

function readCredentials(): Credentials {
  const { file } = credentialsPath();
  if (!existsSync(file)) {
    return {};
  }
  try {
    return CredentialsSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    // A corrupt store should never strand the user — treat it as empty and let the
    // next write replace it.
    return {};
  }
}

function writeCredentials(next: Credentials) {
  const { dir, file } = credentialsPath();
  mkdirSync(dir, { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(temp, file);
}

/** The Vercel AI Gateway key the user set from the studio, if any. */
export function getStoredGatewayKey(): string | undefined {
  return readCredentials().gateway_api_key?.trim() || undefined;
}

/** The OpenRouter key the user set from the studio, if any. */
export function getStoredOpenRouterKey(): string | undefined {
  return readCredentials().openrouter_api_key?.trim() || undefined;
}

/** Save (or, with an empty string, clear) the studio-set Vercel AI Gateway key. */
export function setStoredGatewayKey(key: string) {
  const trimmed = key.trim();
  const current = readCredentials();
  if (!trimmed) {
    delete current.gateway_api_key;
  } else {
    current.gateway_api_key = trimmed;
  }
  writeCredentials(current);
}

/** Save (or, with an empty string, clear) the studio-set OpenRouter key. */
export function setStoredOpenRouterKey(key: string) {
  const trimmed = key.trim();
  const current = readCredentials();
  if (!trimmed) {
    delete current.openrouter_api_key;
  } else {
    current.openrouter_api_key = trimmed;
  }
  writeCredentials(current);
}

/** Mask a key for display — only ever the last 4 chars, never the secret. */
export function maskKey(key: string): string {
  return key.length <= 4 ? "••••" : `••••${key.slice(-4)}`;
}
