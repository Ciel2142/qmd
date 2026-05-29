/**
 * Permanent memory store for qmd. Facts are one-file-per-fact markdown under
 * memory/{user,feedback,project,reference}/<slug>.md. This module owns frontmatter
 * (qmd's indexer does not parse frontmatter) plus remember/recall/forget logic.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { reindexCollection, type Store } from "./store.js";

export type MemoryType = "user" | "feedback" | "project" | "reference";
export const MEMORY_TYPES: MemoryType[] = ["user", "feedback", "project", "reference"];

export interface MemoryFrontmatter {
  name: string;
  description: string;
  type: MemoryType;
  tags: string[];
  project: string;
  created: string; // YYYY-MM-DD
  pinned: boolean;
  source?: string;
}

export interface ParsedMemory {
  frontmatter: MemoryFrontmatter;
  body: string;
}

/** Default store root; overridable via QMD_MEMORY_DIR (used by tests + custom installs). */
export function memoryRoot(): string {
  return process.env.QMD_MEMORY_DIR || join(homedir(), "experiements", "memory");
}

export function memoryFilePath(root: string, type: MemoryType, slug: string): string {
  return join(root, type, `${slug}.md`);
}

/**
 * Kebab-case slug, truncated to 60 chars on a word boundary.
 * Returns "" when the input has no alphanumeric characters — callers that
 * build file paths from the result must validate for empty.
 */
export function slugify(text: string): string {
  let s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length > 60) {
    s = s.slice(0, 60).replace(/-+[^-]*$/, "").replace(/-+$/, "");
  }
  return s;
}

export function serializeMemory(fm: MemoryFrontmatter, body: string): string {
  // Values are written unquoted; parseMemory is forgiving, but a strict YAML
  // parser may reject values containing ':'. Acceptable for internal files.
  const lines = ["---"];
  lines.push(`name: ${fm.name}`);
  lines.push(`description: ${fm.description}`);
  lines.push(`type: ${fm.type}`);
  lines.push(`tags: [${fm.tags.join(", ")}]`);
  lines.push(`project: ${fm.project}`);
  lines.push(`created: ${fm.created}`);
  lines.push(`pinned: ${fm.pinned}`);
  if (fm.source) lines.push(`source: ${fm.source}`);
  lines.push("---", "", body.trimEnd(), "");
  return lines.join("\n");
}

export function parseMemory(content: string): ParsedMemory {
  const trimmed = content.replace(/^﻿/, "");
  const fm: MemoryFrontmatter = {
    name: "", description: "", type: "reference",
    tags: [], project: "global", created: "", pinned: false,
  };
  let body = trimmed;
  if (trimmed.startsWith("---")) {
    const end = trimmed.indexOf("\n---", 3);
    if (end >= 0) {
      const block = trimmed.slice(3, end).trim();
      body = trimmed.slice(end + 4).replace(/^(\r?\n){1,2}/, "");
      for (const line of block.split(/\r?\n/)) {
        const m = line.match(/^([a-z_]+):\s*(.*)$/i);
        if (!m) continue;
        const key = m[1]!;
        const val = (m[2] ?? "").trim();
        switch (key) {
          case "name": fm.name = val; break;
          case "description": fm.description = val; break;
          case "type": if ((MEMORY_TYPES as string[]).includes(val)) fm.type = val as MemoryType; break;
          case "project": fm.project = val || "global"; break;
          case "created": fm.created = val; break;
          case "source": fm.source = val || undefined; break;
          case "pinned": fm.pinned = val === "true"; break;
          case "tags":
            fm.tags = val.replace(/^\[|\]$/g, "").split(",").map(t => t.trim()).filter(Boolean);
            break;
        }
      }
    }
  }
  return { frontmatter: fm, body };
}

// =============================================================================
// remember() — write a typed fact to disk, index it for lex search, dedup.
// =============================================================================

export const MEMORY_COLLECTION = "memory";

/**
 * Dedup strategy: two-tier.
 *
 * Tier 1 (file-existence): if the computed slug already exists on disk, it is
 *   a duplicate — same or nearly-identical fact text produces the same slug.
 *   This is the primary check and works correctly for tiny collections where
 *   FTS5 BM25 IDF is near-zero (every term appears in 100% of the documents).
 *
 * Tier 2 (FTS score): for near-duplicates with slightly different phrasing,
 *   we additionally check the BM25-normalised score. In FTS5, raw scores are
 *   negative (lower = stronger). The normalised score |x|/(1+|x|) maps to
 *   [0,1): strong(-10)→0.91, medium(-2)→0.67, weak(-0.5)→0.33. For a tiny
 *   collection (1–2 docs) BM25 IDF collapses and scores land near 1e-5, so we
 *   use a very small DEDUP_SCORE_FTS just above floating-point noise. For
 *   larger corpora this still catches genuinely matching documents.
 *   Empirically observed: exact duplicate in 1-doc collection → score ≈ 1e-5.
 */
const DEDUP_SCORE_FTS = 1e-6; // any BM25 hit above floating-point noise is a match

export interface RememberInput {
  fact: string;
  type?: MemoryType;
  tags?: string[];
  project?: string;
  pinned?: boolean;
  source?: string;
  as?: string;        // explicit slug
  description?: string;
  replace?: string;   // slug to overwrite in place (skips dedup)
  force?: boolean;    // write even if a duplicate is found
}

export interface RememberResult {
  wrote: boolean;
  slug: string;
  path: string;
  type: MemoryType;
  duplicateOf?: string; // slug of the existing near-duplicate when wrote === false
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function firstLine(text: string): string {
  return (text.trim().split(/\r?\n/)[0] ?? "").slice(0, 200);
}

function gitCommit(root: string, message: string): void {
  try {
    if (!existsSync(join(root, ".git"))) return;
    spawnSync("git", ["-C", root, "add", "-A"], { stdio: "ignore" });
    spawnSync("git", ["-C", root, "commit", "-m", message], { stdio: "ignore" });
  } catch {
    // best-effort: never fail a write because git is unavailable
  }
}

async function reindexMemory(store: Store, root: string): Promise<void> {
  await reindexCollection(store, root, "**/*.md", MEMORY_COLLECTION);
}

/**
 * Extract the slug from a SearchResult.filepath virtual path.
 * filepath format: "qmd://memory/type/slug.md"
 * Falls back to displayPath ("memory/type/slug.md") or the raw string.
 */
function slugFromFilepath(filepath: string): string {
  // Strip "qmd://" prefix if present, then take the last segment minus ".md"
  const stripped = filepath.startsWith("qmd://") ? filepath.slice(6) : filepath;
  const last = stripped.split("/").pop() ?? "";
  return last.replace(/\.md$/, "") || stripped;
}

export async function remember(
  store: Store,
  root: string,
  input: RememberInput,
): Promise<RememberResult> {
  const type: MemoryType = input.type ?? "reference";

  const slug = input.replace ?? slugify(input.as ?? input.fact);

  // Dedup check — skipped when --replace or --force is set.
  if (!input.replace && !input.force) {
    // Tier 1: file-existence check (exact/near-identical fact → same slug).
    const candidatePath = memoryFilePath(root, type, slug);
    if (existsSync(candidatePath)) {
      return { wrote: false, slug, path: candidatePath, type, duplicateOf: slug };
    }

    // Tier 2: FTS near-duplicate check (different phrasing, same meaning).
    // BM25 IDF is near-zero for tiny collections so threshold is intentionally
    // very small — any positive hit counts.
    const hits = store.searchFTS(input.fact, 1, MEMORY_COLLECTION);
    const top = hits[0];
    if (top !== undefined && top.score > DEDUP_SCORE_FTS) {
      const dupSlug = slugFromFilepath(top.filepath);
      // searchFTS returns a virtual "qmd://memory/<type>/<slug>.md" path; resolve
      // it back to a real filesystem path and the hit's actual type so the return
      // shape matches the Tier-1 (file-existence) branch.
      const stripped = top.filepath.startsWith("qmd://") ? top.filepath.slice(6) : top.filepath;
      const dupType = (stripped.split("/").slice(-2, -1)[0] ?? type) as MemoryType;
      const dupPath = memoryFilePath(root, dupType, dupSlug);
      return { wrote: false, slug: dupSlug, path: dupPath, type: dupType, duplicateOf: dupSlug };
    }
  }
  const fm: MemoryFrontmatter = {
    name: slug,
    description: input.description ?? firstLine(input.fact),
    type,
    tags: input.tags ?? [],
    project: input.project ?? "global",
    created: today(),
    pinned: input.pinned ?? false,
    source: input.source,
  };

  const dir = join(root, type);
  mkdirSync(dir, { recursive: true });
  const path = memoryFilePath(root, type, slug);
  writeFileSync(path, serializeMemory(fm, input.fact));

  await reindexMemory(store, root); // lex-index now; vec via the watch daemon
  gitCommit(root, `remember: ${slug}`);

  return { wrote: true, slug, path, type };
}
