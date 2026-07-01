import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultGraph, FusionGraphSchema, type FusionGraph } from "./graph.ts";

/**
 * Durable, local-first persistence for the single active graph.
 *
 * The graph is the product config, so it must survive server restarts. It's
 * stored as a plain JSON file under `.fusion/` (gitignored) — no database, no
 * external service. Override the location with `FUSION_DATA_DIR`.
 */

function graphPaths() {
  const dir = process.env.FUSION_DATA_DIR?.trim() || join(process.cwd(), ".fusion");
  return { dir, file: join(dir, "graph.json") };
}

export function getActiveGraph(): FusionGraph {
  const { file } = graphPaths();
  if (existsSync(file)) {
    try {
      return FusionGraphSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      // A corrupt graph.json is preserved as `.corrupt` rather than silently
      // discarded — so the next save can't overwrite the user's council without
      // a trace — then we recover from the seed.
      try {
        renameSync(file, `${file}.corrupt`);
      } catch {
        // Best-effort backup; still recover below.
      }
    }
  }
  return defaultGraph(new Date().toISOString());
}

export function saveActiveGraph(graph: FusionGraph): FusionGraph {
  const next = FusionGraphSchema.parse({
    ...graph,
    id: "active",
    updated_at: new Date().toISOString()
  });
  const { dir, file } = graphPaths();
  mkdirSync(dir, { recursive: true });
  // Write to a temp file then rename: rename is atomic on the same filesystem,
  // so a crash mid-write never leaves a half-written graph.json behind.
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(next, null, 2));
  renameSync(temp, file);
  return next;
}
