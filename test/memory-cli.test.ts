import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";

const CLI = join(process.cwd(), "src", "cli", "qmd.ts"); // npm test / vitest run from package root

function runQmd(args: string[], env: Record<string, string>) {
  return spawnSync("bun", [CLI, ...args], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
}

describe("qmd remember/recall/forget CLI", () => {
  let dir: string, memDir: string, cfgDir: string, env: Record<string, string>;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "qmd-cli-"));
    memDir = join(dir, "memory"); cfgDir = join(dir, "config");
    await mkdir(cfgDir, { recursive: true });
    for (const t of ["user", "feedback", "project", "reference"]) await mkdir(join(memDir, t), { recursive: true });
    await writeFile(join(cfgDir, "index.yml"),
      YAML.stringify({ collections: { memory: { path: memDir, pattern: "**/*.md" } } }));
    env = { QMD_CONFIG_DIR: cfgDir, QMD_MEMORY_DIR: memDir, INDEX_PATH: join(dir, "index.sqlite") };
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test("remember then recall round-trips", () => {
    const r = runQmd(["remember", "Gitea registry port 3000 at 192.168.1.34", "--type", "reference"], env);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/remember|✓/i);
    const q = runQmd(["recall", "Gitea registry port", "--lex"], env);
    expect(q.status).toBe(0);
    expect(q.stdout).toContain("gitea");
  });

  test("forget removes a fact", () => {
    runQmd(["remember", "throwaway fact", "--type", "project", "--as", "throwaway"], env);
    const f = runQmd(["forget", "throwaway", "--force"], env);
    expect(f.status).toBe(0);
    expect(f.stdout).toMatch(/forgot|removed|✓/i);
  });
});
