import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";
import { normalizeRepoName } from "./repos.js";

const pexec = promisify(execFile);

/** Largest object we will read into memory. */
export const MAX_BUFFER = 64 * 1024 * 1024;

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SHA_RE = /^[0-9a-fA-F]{4,64}$/;

/** Resolve a repo name to its existing bare directory, or null. */
export function repoDir(name: string): string | null {
  let clean: string;
  try {
    clean = normalizeRepoName(name);
  } catch {
    return null;
  }
  const dir = path.join(config.reposDir, `${clean}.git`);
  return fs.existsSync(dir) ? dir : null;
}

/** Reject refs that could be misread as CLI options or contain odd characters. */
export function safeRef(ref: string): string | null {
  return REF_RE.test(ref) ? ref : null;
}

/** Validate a commit hash (full or abbreviated). */
export function safeSha(sha: string): string | null {
  return SHA_RE.test(sha) ? sha : null;
}

/** Normalize a user-supplied subpath: drop empty/./.. segments. */
export function cleanSubpath(p: string): string {
  return (p || "")
    .split("/")
    .filter((s) => s && s !== "." && s !== "..")
    .join("/");
}

export async function gitText(dir: string, args: string[]): Promise<string> {
  const { stdout } = await pexec("git", ["-C", dir, ...args], { maxBuffer: MAX_BUFFER });
  return stdout as string;
}

export async function gitBuffer(dir: string, args: string[]): Promise<Buffer> {
  const { stdout } = await pexec("git", ["-C", dir, ...args], {
    maxBuffer: MAX_BUFFER,
    encoding: "buffer",
  });
  return stdout as unknown as Buffer;
}
