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

import { recallSession } from "../src/memory.js";
import { writeFile as wf, mkdir as md, mkdtemp as mkd, rm as rmrf } from "node:fs/promises";
import { tmpdir as tmp } from "node:os";
import { join as j } from "node:path";
// NOTE: serializeMemory is already imported in the Task A1 block at the top of this file — do not re-import.

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

describe2("recallSession", () => {
  let memDir: string;
  beforeEach(async () => {
    memDir = await mkd(j(tmp(), "qmd-sess-"));
    for (const t of ["user", "feedback", "project", "reference"]) await md(j(memDir, t), { recursive: true });
    await wf(j(memDir, "user", "who.md"), serializeMemory(
      { name: "who", description: "User is Igor, backend eng", type: "user", tags: [], project: "global", created: "2026-05-01", pinned: false }, "User is Igor, a backend engineer."));
    await wf(j(memDir, "feedback", "terse.md"), serializeMemory(
      { name: "terse", description: "Prefers terse answers", type: "feedback", tags: [], project: "global", created: "2026-05-02", pinned: false }, "Be terse. **Why:** saves time."));
    await wf(j(memDir, "reference", "long.md"), serializeMemory(
      { name: "long", description: "A reference fact", type: "reference", tags: [], project: "global", created: "2026-05-03", pinned: false }, "Some reference detail."));
    await wf(j(memDir, "project", "thisrepo.md"), serializeMemory(
      { name: "thisrepo", description: "build with bun", type: "project", tags: [], project: "memory", created: "2026-05-04", pinned: false }, "Build with bun."));
  });
  afterEach(async () => { await rmrf(memDir, { recursive: true, force: true }); });

  test2("includes user + feedback, excludes reference", async () => {
    const out = await recallSession(memDir, { project: "other" });
    expect2(out).toContain("[user]");
    expect2(out).toContain("[feedback]");
    expect2(out).toContain("Be terse");
    expect2(out).not.toContain("A reference fact");
  });

  test2("includes project facts matching current project", async () => {
    const out = await recallSession(memDir, { project: "memory" });
    expect2(out).toContain("build with bun");
  });

  test2("includes global project facts regardless of current project", async () => {
    await wf(j(memDir, "project", "global-tip.md"), serializeMemory(
      { name: "global-tip", description: "A global tip", type: "project", tags: [], project: "global", created: "2026-05-05", pinned: false }, "Applies everywhere."));
    const out = await recallSession(memDir, { project: "some-other-project" });
    expect2(out).toContain("A global tip");
  });

  test2("respects the byte budget", async () => {
    const out = await recallSession(memDir, { project: "memory", budgetBytes: 40 });
    expect2(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(120); // header + truncation note
    expect2(out).toContain("more —");
  });

  test2("returns empty string when no memories exist", async () => {
    const empty = await mkd(j(tmp(), "qmd-sess-empty-"));
    for (const t of ["user", "feedback", "project", "reference"]) await md(j(empty, t), { recursive: true });
    const out = await recallSession(empty, { project: "x" });
    expect2(out).toBe("");
    await rmrf(empty, { recursive: true, force: true });
  });
});

import { recallQuery, forget } from "../src/memory.js";

describe2("recallQuery + forget", () => {
  let dir: string, memDir: string, cfgDir: string, store: Store;
  beforeEach(async () => {
    _resetProductionModeForTesting();
    dir = await mkdtemp(join2(tmpdir(), "qmd-rf-"));
    memDir = join2(dir, "memory"); cfgDir = join2(dir, "config");
    await mkdir(cfgDir, { recursive: true });
    for (const t of ["user", "feedback", "project", "reference"]) await mkdir(join2(memDir, t), { recursive: true });
    process.env.QMD_CONFIG_DIR = cfgDir; process.env.QMD_MEMORY_DIR = memDir;
    await writeFile(join2(cfgDir, "index.yml"),
      YAML.stringify({ collections: { memory: { path: memDir, pattern: "**/*.md" } } }));
    store = createStore(join2(dir, "index.sqlite"));
  });
  afterEach(async () => {
    store.close();
    delete process.env.QMD_CONFIG_DIR; delete process.env.QMD_MEMORY_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  test2("recallQuery (lex) finds a remembered fact", async () => {
    await remember(store, memDir, { fact: "MinIO console is on port 9010", type: "reference" });
    const hits = await recallQuery(store, "MinIO console port", { lexOnly: true, limit: 5 });
    expect2(hits.some(h => h.description.includes("MinIO") || h.path.includes("minio"))).toBe(true);
  });

  test2("forget removes the file and drops it from lex search", async () => {
    const r = await remember(store, memDir, { fact: "Ephemeral fact about Dolt", type: "project" });
    const gone = await forget(store, memDir, r.slug);
    expect2(gone.removed).toBe(true);
    const { existsSync: ex } = await import("node:fs");
    expect2(ex(r.path)).toBe(false);
    const hits = store.searchFTS("Ephemeral Dolt", 5, "memory");   // ADAPTED: searchFTS (sync, positional) — internal Store has no searchLex
    expect2(hits.length).toBe(0);
  });

  test2("forget on a missing slug returns removed:false", async () => {
    const res = await forget(store, memDir, "no-such-slug");
    expect2(res.removed).toBe(false);
  });
});
