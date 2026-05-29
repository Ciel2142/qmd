import { describe, test, expect } from "vitest";
import {
  parseMemory,
  serializeMemory,
  slugify,
  memoryFilePath,
  type MemoryFrontmatter,
} from "../src/memory.js";

describe("slugify", () => {
  test("kebab-cases and trims", () => {
    expect(slugify("LM Studio embed host!")).toBe("lm-studio-embed-host");
  });
  test("collapses repeats and strips edges", () => {
    expect(slugify("  Foo --- Bar  ")).toBe("foo-bar");
  });
  test("truncates to 60 chars on a word boundary", () => {
    const s = slugify("word ".repeat(40));
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s.endsWith("-")).toBe(false);
  });
  test("returns empty string when no alphanumerics remain", () => {
    expect(slugify("")).toBe("");
    expect(slugify("!!!---???")).toBe("");
  });
});

describe("serializeMemory / parseMemory round-trip", () => {
  const fm: MemoryFrontmatter = {
    name: "lm-studio-embed-host",
    description: "LM Studio embedding host on the Windows box",
    type: "reference",
    tags: ["embedding", "homelab"],
    project: "global",
    created: "2026-05-29",
    pinned: false,
    source: "local-infra notes",
  };

  test("serialize produces frontmatter + body", () => {
    const out = serializeMemory(fm, "The fact body.\n");
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain("name: lm-studio-embed-host");
    expect(out).toContain("type: reference");
    expect(out).toContain("tags: [embedding, homelab]");
    expect(out).toContain("pinned: false");
    expect(out.trimEnd().endsWith("The fact body.")).toBe(true);
  });

  test("parse recovers frontmatter and body", () => {
    const out = serializeMemory(fm, "The fact body.\n");
    const parsed = parseMemory(out);
    expect(parsed.frontmatter).toEqual(fm);
    expect(parsed.body).toBe("The fact body.\n");
  });

  test("parse tolerates missing optional fields", () => {
    const text = `---\nname: x\ndescription: d\ntype: user\ncreated: 2026-05-29\n---\nbody`;
    const parsed = parseMemory(text);
    expect(parsed.frontmatter.name).toBe("x");
    expect(parsed.frontmatter.tags).toEqual([]);
    expect(parsed.frontmatter.pinned).toBe(false);
    expect(parsed.frontmatter.project).toBe("global");
  });
});

describe("memoryFilePath", () => {
  test("joins root/type/slug.md", () => {
    expect(memoryFilePath("/m", "feedback", "be-terse")).toBe("/m/feedback/be-terse.md");
  });
});

import { describe as describe2, test as test2, expect as expect2, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as join2 } from "node:path";
import YAML from "yaml";
import { createStore, _resetProductionModeForTesting, type Store } from "../src/store.js";
import { remember } from "../src/memory.js";

describe2("remember", () => {
  let dir: string, memDir: string, cfgDir: string, store: Store;

  beforeEach(async () => {
    _resetProductionModeForTesting();
    dir = await mkdtemp(join2(tmpdir(), "qmd-mem-"));
    memDir = join2(dir, "memory");
    cfgDir = join2(dir, "config");
    await mkdir(cfgDir, { recursive: true });
    for (const t of ["user", "feedback", "project", "reference"]) {
      await mkdir(join2(memDir, t), { recursive: true });
    }
    process.env.QMD_CONFIG_DIR = cfgDir;
    process.env.QMD_MEMORY_DIR = memDir;
    await writeFile(join2(cfgDir, "index.yml"),
      YAML.stringify({ collections: { memory: { path: memDir, pattern: "**/*.md" } } }));
    store = createStore(join2(dir, "index.sqlite"));
  });

  afterEach(async () => {
    store.close();
    delete process.env.QMD_CONFIG_DIR;
    delete process.env.QMD_MEMORY_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  test2("writes a typed file with frontmatter and returns slug+path", async () => {
    const res = await remember(store, memDir, {
      fact: "The deploy host is the Mac mini at 192.168.1.47",
      type: "reference", tags: ["homelab"], source: "local-infra",
    });
    expect2(res.wrote).toBe(true);
    expect2(res.path).toContain("/reference/");
    const text = await readFile(res.path, "utf-8");
    expect2(text).toContain("type: reference");
    expect2(text).toContain("The deploy host is the Mac mini");
  });

  test2("makes the fact lex-searchable immediately (no embedding)", async () => {
    await remember(store, memDir, { fact: "Redpanda Kafka API on port 9092", type: "project" });
    const hits = store.searchFTS("Redpanda Kafka 9092", 5, "memory");
    expect2(hits.length).toBeGreaterThan(0);
  });

  test2("dedup: near-duplicate is reported, not written, unless --force", async () => {
    await remember(store, memDir, { fact: "Qdrant REST runs on port 6333", type: "reference" });
    const dup = await remember(store, memDir, { fact: "Qdrant REST runs on port 6333", type: "reference" });
    expect2(dup.wrote).toBe(false);
    expect2(dup.duplicateOf).toBeTruthy();
    const forced = await remember(store, memDir, { fact: "Qdrant REST runs on port 6333", type: "reference", force: true });
    expect2(forced.wrote).toBe(true);
  });

  test2("--replace overwrites the named slug in place", async () => {
    const a = await remember(store, memDir, { fact: "old fact", type: "user", as: "my-fact" });
    const b = await remember(store, memDir, { fact: "new fact", type: "user", replace: a.slug });
    expect2(b.slug).toBe("my-fact");
    const text = await readFile(b.path, "utf-8");
    expect2(text).toContain("new fact");
  });
});
