import { homedir as osHomedir } from "node:os";
import { join } from "node:path";

export function qmdHomedir(): string {
  return process.env.HOME || process.env.USERPROFILE || osHomedir() || "/tmp";
}

export function getQmdCacheDir(): string {
  if (process.env.XDG_CACHE_HOME) {
    return join(process.env.XDG_CACHE_HOME, "qmd");
  }
  return join(qmdHomedir(), ".cache", "qmd");
}
