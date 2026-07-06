import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { getActiveGraph, saveActiveGraph } from "./graph-store.ts";
import { FusionGraphSchema, type FusionGraph } from "./graph.ts";
import { councilPresets, type CouncilPreset } from "./councils.ts";

const SavedCouncilSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  graph: FusionGraphSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});

export type SavedCouncil = z.infer<typeof SavedCouncilSchema>;

export type CouncilSummary = {
  id: string;
  name: string;
  description?: string;
  graph: FusionGraph;
  source: "saved" | "preset" | "active";
  created_at?: string;
  updated_at?: string;
};

function dataPaths() {
  const dir = process.env.FUSION_DATA_DIR?.trim() || join(process.cwd(), ".fusion");
  return { dir, councils: join(dir, "councils.json") };
}

function readSavedCouncils(): SavedCouncil[] {
  const { councils } = dataPaths();
  if (!existsSync(councils)) return [];
  try {
    const parsed = z.array(SavedCouncilSchema).parse(JSON.parse(readFileSync(councils, "utf8")));
    return parsed.sort((left, right) =>
      new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime()
    );
  } catch {
    try {
      renameSync(councils, `${councils}.corrupt`);
    } catch {
      // Best-effort backup; recover to an empty saved-council list.
    }
    return [];
  }
}

function writeSavedCouncils(records: SavedCouncil[]) {
  const { dir, councils } = dataPaths();
  mkdirSync(dir, { recursive: true });
  const temp = `${councils}.tmp`;
  writeFileSync(temp, JSON.stringify(records, null, 2));
  renameSync(temp, councils);
}

function presetSummary(preset: CouncilPreset): CouncilSummary {
  return {
    id: preset.id,
    name: preset.name,
    description: preset.description,
    graph: preset.graph,
    source: "preset"
  };
}

export function listCouncils(): CouncilSummary[] {
  const active = getActiveGraph();
  return [
    {
      id: "active",
      name: active.name || "Current council",
      description: "The council currently served by the local endpoint.",
      graph: active,
      source: "active",
      updated_at: active.updated_at
    },
    ...readSavedCouncils().map((record) => ({ ...record, source: "saved" as const })),
    ...Object.values(councilPresets).map(presetSummary)
  ];
}

export function getCouncil(id: string): CouncilSummary | undefined {
  return listCouncils().find((council) => council.id === id);
}

export function saveCouncil(input: {
  id?: string;
  name: string;
  description?: string;
  graph: FusionGraph;
}): SavedCouncil {
  const now = new Date().toISOString();
  const records = readSavedCouncils();
  const id = input.id?.trim() || `council_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const existing = records.find((record) => record.id === id);
  const record = SavedCouncilSchema.parse({
    id,
    name: input.name.trim(),
    description: input.description?.trim() || undefined,
    graph: FusionGraphSchema.parse({
      ...input.graph,
      id,
      name: input.graph.name || id,
      updated_at: now
    }),
    created_at: existing?.created_at ?? now,
    updated_at: now
  });
  writeSavedCouncils([record, ...records.filter((entry) => entry.id !== id)]);
  return record;
}

export function activateCouncil(id: string): FusionGraph | undefined {
  const council = getCouncil(id);
  if (!council) return undefined;
  return saveActiveGraph(council.graph);
}
