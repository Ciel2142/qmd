import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createStore, reindexCollection, generateEmbeddings, getHashesNeedingEmbedding, type Store } from "../src/store.js";
import { setConfigSource, type CollectionConfig, type NamedCollection } from "../src/collections.js";
import {
  runCheckOnce,
  effectiveAction,
  writeStatusFile,
  readStatusFile,
  daemonPaths,
  applyAction,
} from "../src/daemon.js";
import { setDefaultLlamaCpp } from "../src/llm.js";

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

describe("applyAction", () => {
  function createFakeTokenizer() {
    return {
      async tokenize(text: string) {
        return new Array(Math.max(1, Math.ceil(text.length / 16))).fill(1);
      },
    };
  }

  function createFakeEmbedLlm() {
    const embedBatchCalls: string[][] = [];
    const embedCalls: { text: string; options?: { model?: string } }[] = [];
    const embedBatchModelCalls: ({ model?: string } | undefined)[] = [];
    return {
      embedBatchCalls,
      embedCalls,
      embedBatchModelCalls,
      async embed(text: string, options?: { model?: string }) {
        embedCalls.push({ text, options });
        return { embedding: [0.1, 0.2, 0.3], model: "fake-embed" };
      },
      async embedBatch(texts: string[], options?: { model?: string }) {
        embedBatchCalls.push([...texts]);
        embedBatchModelCalls.push(options);
        return texts.map((_text, index) => ({
          embedding: [index + 1, index + 2, index + 3],
          model: "fake-embed",
        }));
      },
    };
  }

  let root: string;
  let colDir: string;
  let store: Store;

  beforeEach(async () => {
    ({ root, colDir, store } = await setup());
  });
  afterEach(async () => {
    setDefaultLlamaCpp(null);
    setConfigSource();
    store.db.close();
    await rm(root, { recursive: true, force: true });
  });

  const col = (colPath: string): NamedCollection => ({ name: "col", path: colPath, pattern: "**/*.md" });
  const cfg = (colPath: string): CollectionConfig => ({
    models: { embed: "test-model" },
    collections: { col: { path: colPath, pattern: "**/*.md" } },
  });

  test("notify performs no mutation", async () => {
    await writeFile(join(colDir, "a.md"), "# A\n\nalpha");
    const before = store.db.prepare(`SELECT COUNT(*) c FROM documents`).get() as { c: number };
    const s = { collection: "col", filesNew: 1, filesChanged: 0, filesRemoved: 0, needEmbed: 0, stale: true };
    await applyAction(store, col(colDir), s, "notify", cfg(colDir));
    const after = store.db.prepare(`SELECT COUNT(*) c FROM documents`).get() as { c: number };
    expect(after.c).toBe(before.c); // unchanged (still 0 indexed)
  });

  test("update reindexes new files but does not embed", async () => {
    await writeFile(join(colDir, "a.md"), "# A\n\nalpha");
    const s = { collection: "col", filesNew: 1, filesChanged: 0, filesRemoved: 0, needEmbed: 0, stale: true };
    await applyAction(store, col(colDir), s, "update", cfg(colDir));
    const docs = store.db.prepare(`SELECT COUNT(*) c FROM documents WHERE active = 1`).get() as { c: number };
    expect(docs.c).toBe(1);
    const vecs = store.db.prepare(`SELECT COUNT(*) c FROM content_vectors`).get() as { c: number };
    expect(vecs.c).toBe(0);
  });

  test("update+embed reindexes and embeds", async () => {
    setDefaultLlamaCpp(createFakeTokenizer() as any);
    store.llm = createFakeEmbedLlm() as any;
    await writeFile(join(colDir, "a.md"), "# A\n\nalpha");
    const s = { collection: "col", filesNew: 1, filesChanged: 0, filesRemoved: 0, needEmbed: 0, stale: true };
    await applyAction(store, col(colDir), s, "update+embed", cfg(colDir));
    const vecs = store.db.prepare(`SELECT COUNT(*) c FROM content_vectors`).get() as { c: number };
    expect(vecs.c).toBeGreaterThan(0);
    expect(getHashesNeedingEmbedding(store.db, "col", "test-model")).toBe(0);
  });

  test("update with a failing update command throws so the loop can record it", async () => {
    await writeFile(join(colDir, "a.md"), "# A\n\nalpha");
    const failingCol: NamedCollection = {
      name: "col",
      path: colDir,
      pattern: "**/*.md",
      update: "exit 3",
    };
    const s = { collection: "col", filesNew: 1, filesChanged: 0, filesRemoved: 0, needEmbed: 0, stale: true };
    await expect(applyAction(store, failingCol, s, "update", cfg(colDir))).rejects.toThrow(
      /update command failed/,
    );
    // The throw happens before reindex, so nothing was indexed.
    const docs = store.db.prepare(`SELECT COUNT(*) c FROM documents WHERE active = 1`).get() as { c: number };
    expect(docs.c).toBe(0);
  });
});
