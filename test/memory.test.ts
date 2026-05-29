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
