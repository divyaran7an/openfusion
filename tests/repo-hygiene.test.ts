import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const ignoredDirectories = new Set([
  ".git",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules"
]);
const textExtensions = new Set([
  ".css",
  ".env",
  ".example",
  ".html",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".txt",
  ".yml",
  ".yaml"
]);
const extensionlessTextFiles = new Set([
  ".env.example",
  ".gitignore",
  "CONTRIBUTING",
  "LICENSE",
  "README",
  "SECURITY"
]);
const personalHomePathPattern = /(?<![A-Za-z0-9:])\/(?:Users|home)\/[A-Za-z0-9._-]+/g;

function isTextFile(filePath: string): boolean {
  const basename = path.basename(filePath);
  if (extensionlessTextFiles.has(basename)) {
    return true;
  }

  return textExtensions.has(path.extname(filePath));
}

function listTextFiles(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory)) {
    if (ignoredDirectories.has(entry)) {
      continue;
    }

    const entryPath = path.join(directory, entry);
    const stat = statSync(entryPath);
    if (stat.isDirectory()) {
      files.push(...listTextFiles(entryPath));
      continue;
    }

    if (stat.isFile() && isTextFile(entryPath)) {
      files.push(entryPath);
    }
  }

  return files;
}

test("public repo text avoids hardcoded personal home paths", () => {
  assert.equal(existsSync(repoRoot), true);

  const failures = listTextFiles(repoRoot).flatMap((filePath) => {
    const relativePath = path.relative(repoRoot, filePath);
    return readFileSync(filePath, "utf8")
      .split("\n")
      .flatMap((line, index) => {
        const matches = line.match(personalHomePathPattern) ?? [];
        return matches.map((match) => `${relativePath}:${index + 1}: ${match}`);
      });
  });

  assert.deepEqual(failures, []);
});
