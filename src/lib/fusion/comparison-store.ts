import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CompareTargetSchema, CouncilRunRecordSchema } from "./compare.ts";

const ComparisonSchema = z.object({
  id: z.string().min(1),
  object: z.literal("fusion.comparison"),
  task: z.string().min(1),
  target: CompareTargetSchema,
  teacher_council_id: z.string().min(1).optional(),
  candidate_council_ids: z.array(z.string().min(1)).min(1),
  runs: z.array(CouncilRunRecordSchema),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});

export type Comparison = z.infer<typeof ComparisonSchema>;

function dataPaths() {
  const dir = process.env.FUSION_DATA_DIR?.trim() || join(process.cwd(), ".fusion");
  return { dir, comparisons: join(dir, "comparisons.json") };
}

function readComparisons(): Comparison[] {
  const { comparisons } = dataPaths();
  if (!existsSync(comparisons)) return [];
  try {
    const parsed = z.array(ComparisonSchema).parse(JSON.parse(readFileSync(comparisons, "utf8")));
    return parsed.sort((left, right) =>
      new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
    );
  } catch {
    try {
      renameSync(comparisons, `${comparisons}.corrupt`);
    } catch {
      // Best-effort backup; recover to an empty comparison list.
    }
    return [];
  }
}

function writeComparisons(records: Comparison[]) {
  const { dir, comparisons } = dataPaths();
  mkdirSync(dir, { recursive: true });
  const temp = `${comparisons}.tmp`;
  writeFileSync(temp, JSON.stringify(records, null, 2));
  renameSync(temp, comparisons);
}

export function listComparisons() {
  return readComparisons();
}

export function getComparison(id: string) {
  return readComparisons().find((comparison) => comparison.id === id);
}

export function saveComparison(input: Omit<Comparison, "object" | "created_at" | "updated_at">) {
  const now = new Date().toISOString();
  const records = readComparisons();
  const existing = records.find((comparison) => comparison.id === input.id);
  const record = ComparisonSchema.parse({
    ...input,
    object: "fusion.comparison",
    created_at: existing?.created_at ?? now,
    updated_at: now
  });
  writeComparisons([record, ...records.filter((comparison) => comparison.id !== record.id)]);
  return record;
}
