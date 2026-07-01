import type { Dirent } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import {
  hasLocalTools,
  localToolRootLabels
} from "./local-tools-config.ts";

const DEFAULT_MAX_READ_BYTES = 80_000;
const DEFAULT_MAX_SEARCH_BYTES = 200_000;
const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_SEARCH_DEPTH = 6;

const excludedNames = new Set([
  ".DS_Store",
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target"
]);

const sensitiveNamePatterns = [
  /^\.env(?:\..*)?$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)$/i,
  /^known_hosts$/i,
  /^credentials?(?:\..*)?$/i,
  /^auth(?:\..*)?$/i,
  /^token(?:s)?(?:\..*)?$/i,
  /^secret(?:s)?(?:\..*)?$/i,
  /^.*(?:api[-_]?key|private[-_]?key|access[-_]?token|refresh[-_]?token).*$/i,
  /^.*\.(?:pem|p12|pfx|key)$/i
];

const sensitiveDirectoryNames = new Set([
  ".aws",
  ".azure",
  ".claude",
  ".codex",
  ".config",
  ".gnupg",
  ".ssh",
  "auth",
  "credentials",
  "secrets"
]);

type SafePathResult =
  | {
      ok: true;
      requestedPath: string;
      resolvedPath: string;
      stat: Awaited<ReturnType<typeof fs.stat>>;
    }
  | {
      ok: false;
      requestedPath: string;
      reason: string;
      candidates?: string[];
    };

type DirectoryEntry = {
  name: string;
  path: string;
  type: "directory" | "file" | "symlink" | "other";
  size: number;
  modified_at: string;
};

type SearchMatch = {
  title: string;
  path: string;
  line: number;
  snippet: string;
};

function homeDir() {
  return process.env.HOME || homedir();
}

function normalizeConfiguredRoot(root: string) {
  const trimmed = root.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "~") {
    return homeDir();
  }
  if (trimmed.startsWith("~/")) {
    return path.join(homeDir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

function configuredRootInputs() {
  return localToolRootLabels()
    .map(normalizeConfiguredRoot)
    .filter((root): root is string => Boolean(root));
}

async function allowedRoots() {
  const roots = await Promise.all(
    configuredRootInputs().map(async (root) => {
      try {
        return await fs.realpath(root);
      } catch {
        return undefined;
      }
    })
  );

  return [...new Set(roots.filter((root): root is string => Boolean(root)))];
}

function expandPath(inputPath: string) {
  const raw = inputPath.trim();
  const home = homeDir();

  if (!raw || raw === ".") {
    return process.cwd();
  }
  if (raw === "~") {
    return home;
  }
  if (raw.startsWith("~/")) {
    return path.join(home, raw.slice(2));
  }

  const desktopMatch = /^\/?desktop(?:\/(.*))?$/i.exec(raw);
  if (desktopMatch) {
    return path.join(home, "Desktop", desktopMatch[1] ?? "");
  }

  const downloadsMatch = /^\/?downloads(?:\/(.*))?$/i.exec(raw);
  if (downloadsMatch) {
    return path.join(home, "Downloads", downloadsMatch[1] ?? "");
  }

  return path.resolve(raw);
}

function isInside(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathSegments(targetPath: string) {
  return targetPath.split(path.sep).filter(Boolean);
}

function isSensitiveName(name: string) {
  return sensitiveNamePatterns.some((pattern) => pattern.test(name));
}

function isSensitivePath(targetPath: string) {
  return pathSegments(targetPath).some((segment) => {
    const normalized = segment.toLowerCase();
    return sensitiveDirectoryNames.has(normalized) || isSensitiveName(segment);
  });
}

function isExcludedName(name: string) {
  return excludedNames.has(name);
}

async function findCandidates(inputPath: string, maxResults = 8) {
  const roots = await allowedRoots();
  const requestedName = path.basename(expandPath(inputPath)).toLowerCase();
  if (!requestedName || requestedName === path.sep) {
    return [];
  }

  const candidates: string[] = [];

  async function walk(directory: string, depth: number) {
    if (depth > 5 || candidates.length >= maxResults || isSensitivePath(directory)) {
      return;
    }

    let entries: Dirent<string>[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (candidates.length >= maxResults) {
        return;
      }
      if (
        isExcludedName(entry.name) ||
        isSensitiveName(entry.name) ||
        sensitiveDirectoryNames.has(entry.name.toLowerCase())
      ) {
        continue;
      }

      const fullPath = path.join(directory, entry.name);
      const lowerName = entry.name.toLowerCase();
      if (lowerName === requestedName || lowerName.includes(requestedName)) {
        candidates.push(fullPath);
      }

      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      }
    }
  }

  for (const root of roots) {
    await walk(root, 0);
    if (candidates.length >= maxResults) {
      break;
    }
  }

  return candidates;
}

async function safePath(inputPath: string): Promise<SafePathResult> {
  const requestedPath = inputPath.trim() || ".";
  const expandedPath = expandPath(requestedPath);

  if (isSensitivePath(expandedPath)) {
    return {
      ok: false,
      requestedPath,
      reason:
        "Access denied. Fusion local tools do not read credential, token, key, auth, or .env paths."
    };
  }

  const roots = await allowedRoots();
  if (roots.length === 0) {
    return {
      ok: false,
      requestedPath,
      reason: "No readable local roots are configured for Fusion local tools."
    };
  }

  let resolvedPath: string;
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    resolvedPath = await fs.realpath(expandedPath);
    stat = await fs.stat(resolvedPath);
  } catch {
    return {
      ok: false,
      requestedPath,
      reason: "Path does not exist within the configured local roots.",
      candidates: await findCandidates(requestedPath)
    };
  }

  if (!roots.some((root) => isInside(root, resolvedPath))) {
    return {
      ok: false,
      requestedPath,
      reason: "Access denied. The resolved path is outside Fusion's configured local roots."
    };
  }

  if (isSensitivePath(resolvedPath)) {
    return {
      ok: false,
      requestedPath,
      reason:
        "Access denied. Fusion local tools do not read credential, token, key, auth, or .env paths."
    };
  }

  return { ok: true, requestedPath, resolvedPath, stat };
}

function entryType(entry: Dirent<string>): DirectoryEntry["type"] {
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  if (entry.isSymbolicLink()) return "symlink";
  return "other";
}

async function listDirectory(directoryPath: string, maxEntries: number): Promise<DirectoryEntry[]> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const visible = entries
    .filter((entry) => {
      const fullPath = path.join(directoryPath, entry.name);
      return (
        !isExcludedName(entry.name) &&
        !isSensitiveName(entry.name) &&
        !isSensitivePath(fullPath)
      );
    })
    .sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) {
        return left.isDirectory() ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    })
    .slice(0, Math.max(1, Math.min(maxEntries, 500)));

  return Promise.all(
    visible.map(async (entry) => {
      const fullPath = path.join(directoryPath, entry.name);
      const stat = await fs.stat(fullPath).catch(() => undefined);
      return {
        name: entry.name,
        path: fullPath,
        type: entryType(entry),
        size: stat?.size ?? 0,
        modified_at: stat?.mtime?.toISOString() ?? ""
      };
    })
  );
}

async function readTextPrefix(filePath: string, maxBytes: number) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(Math.max(1, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const slice = buffer.subarray(0, bytesRead);
    if (slice.includes(0)) {
      return { ok: false as const, reason: "File appears to be binary." };
    }
    return { ok: true as const, text: slice.toString("utf8"), truncated: bytesRead === maxBytes };
  } finally {
    await handle.close();
  }
}

async function collectSearchFiles(rootPath: string, maxDepth: number, maxFiles: number) {
  const files: string[] = [];

  async function walk(currentPath: string, depth: number) {
    if (files.length >= maxFiles || depth > maxDepth || isSensitivePath(currentPath)) {
      return;
    }

    const current = await fs.stat(currentPath).catch(() => undefined);
    if (!current) {
      return;
    }

    if (current.isFile()) {
      if (current.size <= DEFAULT_MAX_SEARCH_BYTES && !isSensitivePath(currentPath)) {
        files.push(currentPath);
      }
      return;
    }

    if (!current.isDirectory()) {
      return;
    }

    const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        return;
      }
      if (isExcludedName(entry.name) || isSensitiveName(entry.name)) {
        continue;
      }
      await walk(path.join(currentPath, entry.name), depth + 1);
    }
  }

  await walk(rootPath, 0);
  return files;
}

function findLineMatches(filePath: string, text: string, query: string, maxMatches: number) {
  const matches: SearchMatch[] = [];
  const needle = query.toLowerCase();
  const lines = text.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    if (matches.length >= maxMatches) {
      break;
    }
    if (line.toLowerCase().includes(needle)) {
      matches.push({
        title: `${filePath}:${index + 1}`,
        path: filePath,
        line: index + 1,
        snippet: line.trim().slice(0, 500)
      });
    }
  }

  return matches;
}

const localList = tool({
  description:
    "List a local directory or inspect a local file path inside Fusion's configured safe roots. Use this before claiming you cannot access a local path.",
  inputSchema: z.object({
    path: z
      .string()
      .describe("Local path, e.g. /Users/divya/Desktop/project, ~/Desktop, or /desktop/project."),
    maxEntries: z.number().int().min(1).max(500).optional()
  }),
  execute: async ({ path: inputPath, maxEntries = DEFAULT_MAX_ENTRIES }) => {
    const target = await safePath(inputPath);
    if (!target.ok) {
      return {
        ok: false,
        path: target.requestedPath,
        error: target.reason,
        candidates: target.candidates ?? []
      };
    }

    if (target.stat.isFile()) {
      return {
        ok: true,
        path: target.resolvedPath,
        type: "file",
        size: target.stat.size,
        modified_at: target.stat.mtime.toISOString()
      };
    }

    if (!target.stat.isDirectory()) {
      return {
        ok: false,
        path: target.resolvedPath,
        error: "Path exists but is not a directory or file."
      };
    }

    const entries = await listDirectory(target.resolvedPath, maxEntries);
    return {
      ok: true,
      path: target.resolvedPath,
      type: "directory",
      count: entries.length,
      truncated: entries.length >= maxEntries,
      entries,
      results: entries.slice(0, 20).map((entry) => ({
        title: entry.path,
        snippet: `${entry.type} ${entry.size} bytes`
      }))
    };
  }
});

const localRead = tool({
  description:
    "Read a local text file inside Fusion's configured safe roots. Never use this for secrets, credentials, keys, tokens, auth files, or .env files.",
  inputSchema: z.object({
    path: z.string().describe("Local text file path to read."),
    maxBytes: z.number().int().min(1_000).max(120_000).optional()
  }),
  execute: async ({ path: inputPath, maxBytes = DEFAULT_MAX_READ_BYTES }) => {
    const target = await safePath(inputPath);
    if (!target.ok) {
      return {
        ok: false,
        path: target.requestedPath,
        error: target.reason,
        candidates: target.candidates ?? []
      };
    }

    if (!target.stat.isFile()) {
      return {
        ok: false,
        path: target.resolvedPath,
        error: "Path is not a file. Use localList for directories."
      };
    }

    const read = await readTextPrefix(target.resolvedPath, maxBytes);
    if (!read.ok) {
      return {
        ok: false,
        path: target.resolvedPath,
        error: read.reason
      };
    }

    return {
      ok: true,
      path: target.resolvedPath,
      size: target.stat.size,
      truncated: read.truncated || target.stat.size > maxBytes,
      text: read.text,
      results: [
        {
          title: target.resolvedPath,
          snippet: read.text.slice(0, 500)
        }
      ]
    };
  }
});

const localSearch = tool({
  description:
    "Search local text files by substring inside Fusion's configured safe roots. Excludes credentials, build output, git data, and dependencies.",
  inputSchema: z.object({
    query: z.string().min(1).describe("Case-insensitive substring to search for."),
    path: z
      .string()
      .optional()
      .describe("Optional local directory or file path to search. Defaults to the configured workspace."),
    maxDepth: z.number().int().min(0).max(10).optional(),
    maxMatches: z.number().int().min(1).max(120).optional()
  }),
  execute: async ({
    query,
    path: inputPath = process.cwd(),
    maxDepth = DEFAULT_SEARCH_DEPTH,
    maxMatches = 80
  }) => {
    const target = await safePath(inputPath);
    if (!target.ok) {
      return {
        ok: false,
        path: target.requestedPath,
        query,
        error: target.reason,
        candidates: target.candidates ?? []
      };
    }

    const files = target.stat.isFile()
      ? [target.resolvedPath]
      : await collectSearchFiles(target.resolvedPath, maxDepth, 1_000);
    const matches: SearchMatch[] = [];

    for (const filePath of files) {
      if (matches.length >= maxMatches) {
        break;
      }

      const read = await readTextPrefix(filePath, DEFAULT_MAX_SEARCH_BYTES).catch(() => undefined);
      if (!read?.ok) {
        continue;
      }

      matches.push(...findLineMatches(filePath, read.text, query, maxMatches - matches.length));
    }

    return {
      ok: true,
      path: target.resolvedPath,
      query,
      searched_files: files.length,
      count: matches.length,
      results: matches
    };
  }
});

export function localToolsFor(enabled: boolean) {
  if (!enabled || !hasLocalTools()) {
    return undefined;
  }

  return {
    localList,
    localRead,
    localSearch
  };
}
