import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolveChunkStrategy,
  resolveEmbedChunkStrategy,
  type CollectionConfig,
} from "../src/collections.js";

const baseConfig: CollectionConfig = {
  chunk_strategy: "regex",
  collections: {
    code: { path: "/x", pattern: "**/*.ts", chunk_strategy: "auto" },
    notes: { path: "/y", pattern: "**/*.md" },
  },
};

describe("resolveChunkStrategy precedence", () => {
  test("CLI flag wins over everything", () => {
    expect(resolveChunkStrategy("regex", baseConfig.collections.code, baseConfig)).toBe("regex");
  });
  test("per-collection wins over global when no flag", () => {
    expect(resolveChunkStrategy(undefined, baseConfig.collections.code, baseConfig)).toBe("auto");
  });
  test("global applies when collection has no override", () => {
    expect(resolveChunkStrategy(undefined, baseConfig.collections.notes, baseConfig)).toBe("regex");
  });
  test("global applies when collection is undefined (embed-all)", () => {
    expect(resolveChunkStrategy(undefined, undefined, baseConfig)).toBe("regex");
  });
  test("falls back to built-in regex when nothing set", () => {
    expect(resolveChunkStrategy(undefined, undefined, { collections: {} })).toBe("regex");
  });
  test("CLI flag beats global when collection has no override", () => {
    expect(resolveChunkStrategy("auto", baseConfig.collections.notes, baseConfig)).toBe("auto");
  });
});

describe("resolveEmbedChunkStrategy reads config from disk", () => {
  let savedConfigDir: string | undefined;
  let dir: string;
  beforeEach(async () => {
    savedConfigDir = process.env.QMD_CONFIG_DIR;
    dir = await mkdtemp(join(tmpdir(), "qmd-chunkcfg-"));
    process.env.QMD_CONFIG_DIR = dir;
    await writeFile(
      join(dir, "index.yml"),
      "chunk_strategy: regex\ncollections:\n  code:\n    path: /x\n    pattern: '**/*.ts'\n    chunk_strategy: auto\n",
    );
  });
  afterEach(async () => {
    if (savedConfigDir === undefined) delete process.env.QMD_CONFIG_DIR;
    else process.env.QMD_CONFIG_DIR = savedConfigDir;
    await rm(dir, { recursive: true, force: true });
  });

  test("uses per-collection override for a named collection", () => {
    expect(resolveEmbedChunkStrategy(undefined, "code")).toBe("auto");
  });
  test("uses global default when no collection given", () => {
    expect(resolveEmbedChunkStrategy(undefined, undefined)).toBe("regex");
  });
  test("CLI flag overrides config", () => {
    expect(resolveEmbedChunkStrategy("regex", "code")).toBe("regex");
  });
  test("unknown collection name falls back to global default", () => {
    expect(resolveEmbedChunkStrategy(undefined, "nonexistent")).toBe("regex");
  });
});
