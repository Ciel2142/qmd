import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createStore, _resetProductionModeForTesting, type Store } from "../src/store.js";
import { remember, recallQuery, forget } from "../src/memory.js";

describe("memory MCP handler contract", () => {
  let dir: string, memDir: string, store: Store;
  beforeEach(async () => {
    _resetProductionModeForTesting();
    dir = await mkdtemp(join(tmpdir(), "qmd-mcp-"));
    memDir = join(dir, "memory");
    const cfgDir = join(dir, "config");
    await mkdir(cfgDir, { recursive: true });
    for (const t of ["user", "feedback", "project", "reference"]) await mkdir(join(memDir, t), { recursive: true });
    process.env.QMD_CONFIG_DIR = cfgDir; process.env.QMD_MEMORY_DIR = memDir;
    await writeFile(join(cfgDir, "index.yml"), YAML.stringify({ collections: { memory: { path: memDir, pattern: "**/*.md" } } }));
    store = createStore(join(dir, "index.sqlite"));
  });
  afterEach(async () => { store.close(); delete process.env.QMD_CONFIG_DIR; delete process.env.QMD_MEMORY_DIR; await rm(dir, { recursive: true, force: true }); });

  test("remember → recall → forget", async () => {
    const r = await remember(store, memDir, { fact: "OTEL collector OTLP gRPC on 4317", type: "reference" });
    expect(r.wrote).toBe(true);
    const hits = await recallQuery(store, memDir, "OTEL OTLP 4317", { lexOnly: true });   // root = memDir (2nd arg)
    expect(hits.length).toBeGreaterThan(0);
    const g = await forget(store, memDir, r.slug);
    expect(g.removed).toBe(true);
  });
});
