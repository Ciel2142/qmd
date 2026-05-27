/**
 * Read-only staleness detection for collections.
 *
 * Computes, without mutating the index, how many files are new / changed /
 * removed on disk relative to the index, plus how many content hashes still
 * need embedding for the active model.
 */
import { statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type Store,
  listCollectionFiles,
  handelize,
  hashContent,
  getRealPath,
  getHashesNeedingEmbedding,
} from "./store.js";
import type { NamedCollection } from "./collections.js";

export interface CollectionStaleness {
  collection: string;
  filesNew: number;
  filesChanged: number;
  filesRemoved: number;
  needEmbed: number;
  stale: boolean;
}

export async function detectCollectionStaleness(
  store: Store,
  col: NamedCollection,
  embedModel: string,
): Promise<CollectionStaleness> {
  const files = await listCollectionFiles(col.path, col.pattern || "**/*.md", col.ignore);

  const rows = store.db
    .prepare(`SELECT path, hash, modified_at FROM documents WHERE collection = ? AND active = 1`)
    .all(col.name) as { path: string; hash: string; modified_at: string }[];
  const byPath = new Map(rows.map((r) => [r.path, r]));

  const seen = new Set<string>();
  let filesNew = 0;
  let filesChanged = 0;

  for (const relativeFile of files) {
    const path = handelize(relativeFile);
    seen.add(path);
    const existing = byPath.get(path);
    if (!existing) {
      filesNew++;
      continue;
    }
    const filepath = getRealPath(resolve(col.path, relativeFile));
    let mtimeIso: string;
    try {
      mtimeIso = new Date(statSync(filepath).mtime).toISOString();
    } catch {
      continue;
    }
    if (mtimeIso === existing.modified_at) continue; // cheap prefilter: unchanged
    let content: string;
    try {
      content = readFileSync(filepath, "utf-8");
    } catch {
      continue;
    }
    if (!content.trim()) continue;
    const hash = await hashContent(content);
    if (hash !== existing.hash) filesChanged++;
  }

  let filesRemoved = 0;
  for (const r of rows) {
    if (!seen.has(r.path)) filesRemoved++;
  }

  const needEmbed = getHashesNeedingEmbedding(store.db, col.name, embedModel);
  const stale = filesNew + filesChanged + filesRemoved + needEmbed > 0;

  return { collection: col.name, filesNew, filesChanged, filesRemoved, needEmbed, stale };
}
