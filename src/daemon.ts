/**
 * Collection-watch daemon: orchestrates read-only staleness detection into a
 * persisted status object, and (for non-notify actions) applies update/embed.
 */
import { writeFileSync, readFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { type Store } from "./store.js";
import {
  type CollectionConfig,
  type NamedCollection,
  type DaemonAction,
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
