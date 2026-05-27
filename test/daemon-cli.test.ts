import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(thisDir, "..");
const CLI = join(projectRoot, "src", "cli", "qmd.ts");
const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const tsxCli = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cliArgs = isBunRuntime ? [CLI] : [tsxCli, CLI];

function runCli(args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [...cliArgs, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf-8",
  });
}

describe("qmd check", () => {
  let root: string;
  let configDir: string;
  let cacheDir: string;
  let colDir: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qmd-check-cli-"));
    configDir = join(root, "config");
    cacheDir = join(root, "cache");
    colDir = join(root, "col");
    await mkdir(configDir, { recursive: true });
    await mkdir(cacheDir, { recursive: true });
    await mkdir(colDir, { recursive: true });
    await writeFile(join(colDir, "a.md"), "# A\n\nalpha");
    await writeFile(
      join(configDir, "index.yml"),
      `models:\n  embed: test-model\ncollections:\n  col:\n    path: ${colDir}\n    pattern: '**/*.md'\n`,
    );
    env = { QMD_CONFIG_DIR: configDir, XDG_CACHE_HOME: cacheDir };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("exits non-zero and writes status file when a collection is stale", () => {
    const res = runCli(["check", "--json"], env);
    expect(res.status).toBe(1); // not yet indexed/embedded => stale
    const status = JSON.parse(res.stdout);
    expect(status.collections.col.filesNew).toBe(1);
    // status file written under <cacheDir>/qmd/daemon-status.json
    const statusPath = join(cacheDir, "qmd", "daemon-status.json");
    const onDisk = JSON.parse(readFileSync(statusPath, "utf-8"));
    expect(onDisk.collections.col.filesNew).toBe(1);
  });

  test("exits zero when no collection is stale", async () => {
    // Remove the fixture file so the collection has nothing new/changed/removed
    // and nothing to embed -> fresh -> exit 0.
    await rm(join(colDir, "a.md"));
    const res = runCli(["check", "--json"], env);
    expect(res.status).toBe(0);
    const status = JSON.parse(res.stdout);
    expect(status.collections.col.stale).toBe(false);
  });

  test("table output lists the collection and its stale flag", () => {
    const res = runCli(["check"], env); // no --json => printCheckTable
    expect(res.status).toBe(1); // a.md present but unindexed => stale
    expect(res.stdout).toContain("col");
    expect(res.stdout).toContain("STALE");
  });
});

describe("qmd check -c collection filter", () => {
  let root: string;
  let configDir: string;
  let cacheDir: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qmd-check-filter-cli-"));
    configDir = join(root, "config");
    cacheDir = join(root, "cache");
    const staleDir = join(root, "stalecol");
    const freshDir = join(root, "freshcol");
    await mkdir(configDir, { recursive: true });
    await mkdir(cacheDir, { recursive: true });
    await mkdir(staleDir, { recursive: true });
    await mkdir(freshDir, { recursive: true }); // empty dir => nothing new/changed/removed => fresh
    await writeFile(join(staleDir, "a.md"), "# A\n\nalpha");
    await writeFile(
      join(configDir, "index.yml"),
      `models:\n  embed: test-model\ncollections:\n  stalecol:\n    path: ${staleDir}\n    pattern: '**/*.md'\n  freshcol:\n    path: ${freshDir}\n    pattern: '**/*.md'\n`,
    );
    env = { QMD_CONFIG_DIR: configDir, XDG_CACHE_HOME: cacheDir };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("checking only a fresh collection exits 0 even though another collection is stale", () => {
    // Without -c, the stale collection forces exit 1.
    expect(runCli(["check"], env).status).toBe(1);
    // -c freshcol scopes detection to freshcol only => exit 0 (no cron false-positive).
    const res = runCli(["check", "-c", "freshcol", "--json"], env);
    expect(res.status).toBe(0);
    const status = JSON.parse(res.stdout);
    expect(Object.keys(status.collections)).toEqual(["freshcol"]);
  });

  test("checking only the stale collection still exits 1 and reports just that one", () => {
    const res = runCli(["check", "-c", "stalecol", "--json"], env);
    expect(res.status).toBe(1);
    const status = JSON.parse(res.stdout);
    expect(Object.keys(status.collections)).toEqual(["stalecol"]);
  });

  test("an unknown -c name errors instead of silently checking everything", () => {
    const res = runCli(["check", "-c", "nope"], env);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Collection not found: nope");
  });
});

describe("qmd watch lifecycle", () => {
  let root: string;
  let configDir: string;
  let cacheDir: string;
  let colDir: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qmd-watch-cli-"));
    configDir = join(root, "config");
    cacheDir = join(root, "cache");
    colDir = join(root, "col");
    await mkdir(configDir, { recursive: true });
    await mkdir(cacheDir, { recursive: true });
    await mkdir(colDir, { recursive: true });
    await writeFile(join(colDir, "a.md"), "# A\n\nalpha");
    await writeFile(
      join(configDir, "index.yml"),
      `models:\n  embed: test-model\ncollections:\n  col:\n    path: ${colDir}\n    pattern: '**/*.md'\ndaemon:\n  interval: 1\n`,
    );
    env = { QMD_CONFIG_DIR: configDir, XDG_CACHE_HOME: cacheDir };
  });
  afterEach(async () => {
    runCli(["watch", "stop"], env); // best-effort cleanup
    await new Promise((r) => setTimeout(r, 500)); // let the child exit before rm
    await rm(root, { recursive: true, force: true });
  });

  test("--daemon writes a pidfile, then stop removes it and writes a status file", async () => {
    const start = runCli(["watch", "--daemon", "--interval", "1"], env);
    expect(start.status).toBe(0);
    const pidPath = join(cacheDir, "qmd", "watch.pid");
    expect(existsSync(pidPath)).toBe(true);

    const statusPath = join(cacheDir, "qmd", "daemon-status.json");
    const deadline = Date.now() + 10000;
    while (!existsSync(statusPath) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(existsSync(statusPath)).toBe(true);
    const status = JSON.parse(readFileSync(statusPath, "utf-8"));
    expect(status.collections.col).toBeDefined();

    const stop = runCli(["watch", "stop"], env);
    expect(stop.status).toBe(0);
    expect(existsSync(pidPath)).toBe(false);
  });
});

describe("qmd status surfaces daemon status", () => {
  let root: string;
  let configDir: string;
  let cacheDir: string;
  let colDir: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qmd-status-cli-"));
    configDir = join(root, "config");
    cacheDir = join(root, "cache");
    colDir = join(root, "col");
    await mkdir(configDir, { recursive: true });
    await mkdir(cacheDir, { recursive: true });
    await mkdir(colDir, { recursive: true });
    await writeFile(join(colDir, "a.md"), "# A\n\nalpha");
    await writeFile(
      join(configDir, "index.yml"),
      `models:\n  embed: test-model\ncollections:\n  col:\n    path: ${colDir}\n    pattern: '**/*.md'\n`,
    );
    env = { QMD_CONFIG_DIR: configDir, XDG_CACHE_HOME: cacheDir };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("status output includes the last check result after a check", () => {
    runCli(["check"], env); // writes daemon-status.json
    const res = runCli(["status"], env);
    expect(res.status).toBe(0);
    // existing showStatus() output is preserved (additive)
    expect(res.stdout).toContain("QMD Status"); // showStatus() unconditionally prints this header
    // daemon section surfaced
    expect(res.stdout).toMatch(/[Ll]ast check/);
    expect(res.stdout).toContain("col");
    expect(res.stdout).toContain("STALE"); // a.md present but unindexed => stale
  });
});
