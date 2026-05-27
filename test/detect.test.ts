import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createStore, reindexCollection, type Store } from "../src/store.js";
import { detectCollectionStaleness } from "../src/detect.js";
import type { NamedCollection } from "../src/collections.js";

const MODEL = "test-model";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "qmd-detect-"));
  const colDir = join(root, "col");
  await mkdir(colDir, { recursive: true });
  const store = createStore(join(root, "index.sqlite"));
  return { root, colDir, store };
}

function namedCol(path: string): NamedCollection {
  return { name: "col", path, pattern: "**/*.md" };
}

describe("detectCollectionStaleness", () => {
  let root: string;
  let colDir: string;
  let store: Store;

  beforeEach(async () => {
    ({ root, colDir, store } = await setup());
  });
  afterEach(async () => {
    store.db.close();
    await rm(root, { recursive: true, force: true });
  });

  test("clean after indexing: only needEmbed > 0, files all zero", async () => {
    await writeFile(join(colDir, "a.md"), "# A\n\nalpha");
    await reindexCollection(store, colDir, "**/*.md", "col");
    const s = await detectCollectionStaleness(store, namedCol(colDir), MODEL);
    expect(s.filesNew).toBe(0);
    expect(s.filesChanged).toBe(0);
    expect(s.filesRemoved).toBe(0);
    expect(s.needEmbed).toBe(1); // indexed but not embedded
    expect(s.stale).toBe(true);
  });

  test("new file is counted as filesNew", async () => {
    await writeFile(join(colDir, "a.md"), "# A\n\nalpha");
    await reindexCollection(store, colDir, "**/*.md", "col");
    await writeFile(join(colDir, "b.md"), "# B\n\nbeta");
    const s = await detectCollectionStaleness(store, namedCol(colDir), MODEL);
    expect(s.filesNew).toBe(1);
  });

  test("changed content is counted as filesChanged", async () => {
    const f = join(colDir, "a.md");
    await writeFile(f, "# A\n\nalpha");
    await reindexCollection(store, colDir, "**/*.md", "col");
    // Rewrite with new content AND a newer mtime so the prefilter triggers.
    await new Promise((r) => setTimeout(r, 1100));
    await writeFile(f, "# A\n\nALPHA CHANGED");
    const s = await detectCollectionStaleness(store, namedCol(colDir), MODEL);
    expect(s.filesChanged).toBe(1);
    expect(s.filesNew).toBe(0);
  });

  test("deleted file is counted as filesRemoved", async () => {
    await writeFile(join(colDir, "a.md"), "# A\n\nalpha");
    await writeFile(join(colDir, "b.md"), "# B\n\nbeta");
    await reindexCollection(store, colDir, "**/*.md", "col");
    await rm(join(colDir, "b.md"));
    const s = await detectCollectionStaleness(store, namedCol(colDir), MODEL);
    expect(s.filesRemoved).toBe(1);
  });
});
