import { describe, test, expect } from "vitest";
import { getSkillInstallDir, getClaudeSkillLinkPath } from "../src/cli/qmd.js";

describe("skill install dir is parameterized by name", () => {
  test("defaults to qmd", () => {
    expect(getSkillInstallDir(true)).toMatch(/\.agents\/skills\/qmd$/);
  });
  test("accepts an explicit name", () => {
    expect(getSkillInstallDir(true, "qmd-memory")).toMatch(/\.agents\/skills\/qmd-memory$/);
    expect(getClaudeSkillLinkPath(true, "qmd-memory")).toMatch(/\.claude\/skills\/qmd-memory$/);
  });
});
