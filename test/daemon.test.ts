import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createStore, reindexCollection, type Store } from "../src/store.js";
import { setConfigSource, type CollectionConfig } from "../src/collections.js";
import {
  runCheckOnce,
  effectiveAction,
  writeStatusFile,
  readStatusFile,
  daemonPaths,
} from "../src/daemon.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "qmd-daemon-"));
  const colDir = join(root, "col");
  await mkdir(colDir, { recursive: true });
  const store = createStore(join(root, "index.sqlite"));
  return { root, colDir, store };
}

describe("daemon core", () => {
  let root: string;
  let colDir: string;
  let store: Store;

  beforeEach(async () => {
    ({ root, colDir, store } = await setup());
  });
  afterEach(async () => {
    setConfigSource(); // reset to file-based config
    store.db.close();
    await rm(root, { recursive: true, force: true });
  });

  test("effectiveAction: per-collection > daemon default > notify", () => {
    const cfg: CollectionConfig = { collections: {}, daemon: { default_action: "update" } };
    expect(effectiveAction({ name: "x", path: "/", pattern: "**/*.md", action: "update+embed" }, cfg)).toBe("update+embed");
    expect(effectiveAction({ name: "x", path: "/", pattern: "**/*.md" }, cfg)).toBe("update");
    expect(effectiveAction({ name: "x", path: "/", pattern: "**/*.md" }, { collections: {} })).toBe("notify");
  });

  test("runCheckOnce builds a per-collection status from the config", async () => {
    await writeFile(join(colDir, "a.md"), "# A\n\nalpha");
    await reindexCollection(store, colDir, "**/*.md", "col");
    const config: CollectionConfig = {
      models: { embed: "test-model" },
      collections: { col: { path: colDir, pattern: "**/*.md" } },
      daemon: { default_action: "notify" },
    };
    setConfigSource({ config });
    const status = await runCheckOnce(store, config, 300);
    expect(status.interval).toBe(300);
    expect(status.collections.col.needEmbed).toBe(1);
    expect(status.collections.col.stale).toBe(true);
    expect(status.collections.col.action).toBe("notify");
    expect(typeof status.checked_at).toBe("string");
  });

  test("status file round-trips atomically", async () => {
    const { statusPath } = daemonPaths(root);
    const status = await runCheckOnce(store, { collections: {} }, 60);
    writeStatusFile(statusPath, status);
    const read = readStatusFile(statusPath);
    expect(read).toEqual(status);
    expect(readStatusFile(join(root, "missing.json"))).toBeNull();
  });
});
