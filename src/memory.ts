/**
 * Permanent memory store for qmd. Facts are one-file-per-fact markdown under
 * memory/{user,feedback,project,reference}/<slug>.md. This module owns frontmatter
 * (qmd's indexer does not parse frontmatter) plus remember/recall/forget logic.
 */
import { join } from "node:path";
import { homedir } from "node:os";

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
