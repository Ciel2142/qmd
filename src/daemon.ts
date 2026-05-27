/**
 * Collection-watch daemon: orchestrates read-only staleness detection into a
 * persisted status object, and (for non-notify actions) applies update/embed.
 */
import { writeFileSync, readFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import {
  type Store,
  reindexCollection,
  generateEmbeddings,
  getHashesNeedingEmbedding,
} from "./store.js";
import {
  type CollectionConfig,
  type NamedCollection,
  type DaemonAction,
  resolveChunkStrategy,
} from "./collections.js";
import { resolveModels } from "./llm.js";
import { detectCollectionStaleness, type CollectionStaleness } from "./detect.js";

export interface DaemonStatusEntry extends CollectionStaleness {
  action: DaemonAction;
  error?: string;
}

export interface DaemonStatus {
  checked_at: string;
  interval: number;
  collections: Record<string, DaemonStatusEntry>;
}

export function daemonPaths(cacheDir: string): {
  pidPath: string;
  logPath: string;
  statusPath: string;
} {
  return {
    pidPath: join(cacheDir, "watch.pid"),
    logPath: join(cacheDir, "daemon.log"),
    statusPath: join(cacheDir, "daemon-status.json"),
  };
}

export function effectiveAction(col: NamedCollection, config: CollectionConfig): DaemonAction {
  return col.action ?? config.daemon?.default_action ?? "notify";
}

function namedCollections(config: CollectionConfig): NamedCollection[] {
  return Object.entries(config.collections).map(([name, c]) => ({ name, ...c }));
}

export async function runCheckOnce(
  store: Store,
  config: CollectionConfig,
  intervalSeconds: number,
): Promise<DaemonStatus> {
  const embedModel = resolveModels(config.models).embed;
  const status: DaemonStatus = {
    checked_at: new Date().toISOString(),
    interval: intervalSeconds,
    collections: {},
  };
  for (const col of namedCollections(config)) {
    const action = effectiveAction(col, config);
    try {
      const s = await detectCollectionStaleness(store, col, embedModel);
      status.collections[col.name] = { ...s, action };
    } catch (e) {
      status.collections[col.name] = {
        collection: col.name,
        filesNew: 0,
        filesChanged: 0,
        filesRemoved: 0,
        needEmbed: 0,
        stale: false,
        action,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
  return status;
}

export function writeStatusFile(path: string, status: DaemonStatus): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(status, null, 2));
  renameSync(tmp, path);
}

export function readStatusFile(path: string): DaemonStatus | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as DaemonStatus;
  } catch {
    return null;
  }
}

/**
 * Apply a daemon action for one collection. notify is a no-op. update runs the
 * optional `update:` shell command then reindexes. update+embed additionally
 * embeds remaining pending hashes for the collection using the resolved
 * (per-collection) chunk strategy.
 */
export async function applyAction(
  store: Store,
  col: NamedCollection,
  staleness: CollectionStaleness,
  action: DaemonAction,
  config: CollectionConfig,
): Promise<void> {
  if (action === "notify" || !staleness.stale) return;

  if (col.update) {
    const result = spawnSync("bash", ["-c", col.update], {
      cwd: col.path,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const stderr = result.stderr?.toString().trim();
      throw new Error(
        `update command failed (exit ${result.status ?? "signal"})${stderr ? `: ${stderr}` : ""}`,
      );
    }
  }

  const hasFileDeltas =
    staleness.filesNew + staleness.filesChanged + staleness.filesRemoved > 0;
  if (hasFileDeltas || col.update) {
    await reindexCollection(store, col.path, col.pattern || "**/*.md", col.name, {
      ignorePatterns: col.ignore,
    });
  }

  if (action === "update+embed") {
    const model = resolveModels(config.models).embed;
    if (getHashesNeedingEmbedding(store.db, col.name, model) > 0) {
      await generateEmbeddings(store, {
        collection: col.name,
        model,
        chunkStrategy: resolveChunkStrategy(undefined, col, config),
      });
    }
  }
}
