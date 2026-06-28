import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";
import { normalizeRepoName } from "./repos.js";

const pexec = promisify(execFile);

/** Largest blob we will render inline as text. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** Largest object we will read into memory at all. */
const MAX_BUFFER = 64 * 1024 * 1024;

export interface TreeEntry {
  name: string;
  path: string;
  type: "tree" | "blob";
  size: number | null;
  mode: string;
}

export interface BlobResult {
  path: string;
  size: number;
  isBinary: boolean;
  /** Decoded text, or null when binary / too large to display. */
  text: string | null;
  tooLarge: boolean;
  buffer: Buffer;
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  date: Date;
  subject: string;
}

/** Names that count as a repository README, in priority order. */
const README_NAMES = ["README.md", "README.markdown", "README.txt", "README"];

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Reject refs that could be misread as CLI options or contain odd characters. */
function safeRef(ref: string): string | null {
  return REF_RE.test(ref) ? ref : null;
}

/** Resolve a repo name to its existing bare directory. */
function repoDir(name: string): string | null {
  let clean: string;
  try {
    clean = normalizeRepoName(name);
  } catch {
    return null;
  }
  const dir = path.join(config.reposDir, `${clean}.git`);
  return fs.existsSync(dir) ? dir : null;
}

/** Normalize a user-supplied subpath: drop empty/./.. segments. */
export function cleanSubpath(p: string): string {
  return (p || "")
    .split("/")
    .filter((s) => s && s !== "." && s !== "..")
    .join("/");
}

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await pexec("git", ["-C", dir, ...args], { maxBuffer: MAX_BUFFER });
  return stdout as string;
}

async function gitBuffer(dir: string, args: string[]): Promise<Buffer> {
  const { stdout } = await pexec("git", ["-C", dir, ...args], {
    maxBuffer: MAX_BUFFER,
    encoding: "buffer",
  });
  return stdout as unknown as Buffer;
}

/** The object type at `<ref>:<subpath>` ("tree" | "blob"), or null. */
export async function objectType(
  name: string,
  ref: string,
  subpath: string,
): Promise<"tree" | "blob" | null> {
  const dir = repoDir(name);
  const safe = safeRef(ref);
  if (!dir || !safe) return null;
  const sub = cleanSubpath(subpath);
  const spec = sub ? `${safe}:${sub}` : `${safe}^{tree}`;
  try {
    const t = (await git(dir, ["cat-file", "-t", spec])).trim();
    return t === "tree" || t === "blob" ? t : null;
  } catch {
    return null;
  }
}

/** List the immediate entries of a directory at a ref. */
export async function listDirectory(
  name: string,
  ref: string,
  subpath: string,
): Promise<TreeEntry[] | null> {
  const dir = repoDir(name);
  const safe = safeRef(ref);
  if (!dir || !safe) return null;

  const sub = cleanSubpath(subpath);
  const spec = sub ? `${safe}:${sub}` : safe;

  let out: string;
  try {
    out = await git(dir, ["ls-tree", "--long", spec]);
  } catch {
    return null;
  }

  const entries: TreeEntry[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    // <mode> SP <type> SP <object> SP* <size> TAB <name>
    const m = line.match(/^(\d+)\s+(tree|blob|commit)\s+([0-9a-f]+)\s+(\S+)\t(.+)$/);
    if (!m) continue;
    const [, mode, type, , sizeStr, entryName] = m;
    if (type === "commit") continue; // submodule — skip for now
    entries.push({
      name: entryName,
      path: sub ? `${sub}/${entryName}` : entryName,
      type: type as "tree" | "blob",
      size: sizeStr === "-" ? null : Number(sizeStr),
      mode,
    });
  }

  // Directories first, then files; alphabetical within each group.
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "tree" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

const NUL = 0;

/** Read a blob at `<ref>:<subpath>`. */
export async function readBlob(
  name: string,
  ref: string,
  subpath: string,
): Promise<BlobResult | null> {
  const dir = repoDir(name);
  const safe = safeRef(ref);
  if (!dir || !safe) return null;

  const sub = cleanSubpath(subpath);
  if (!sub) return null;
  const spec = `${safe}:${sub}`;

  let size: number;
  try {
    size = Number((await git(dir, ["cat-file", "-s", spec])).trim());
  } catch {
    return null;
  }

  const buffer = await gitBuffer(dir, ["cat-file", "blob", spec]);
  // Binary detection: NUL byte in the first 8KB.
  const sniff = buffer.subarray(0, 8192);
  const isBinary = sniff.includes(NUL);
  const tooLarge = size > MAX_TEXT_BYTES;

  return {
    path: sub,
    size,
    isBinary,
    tooLarge,
    text: isBinary || tooLarge ? null : buffer.toString("utf8"),
    buffer,
  };
}

/** The most recent commit reachable from a ref. */
export async function headCommit(name: string, ref: string): Promise<CommitInfo | null> {
  const dir = repoDir(name);
  const safe = safeRef(ref);
  if (!dir || !safe) return null;
  try {
    const out = await git(dir, [
      "log",
      "-1",
      "--format=%H%x00%h%x00%an%x00%aI%x00%s",
      safe,
    ]);
    const [hash, shortHash, author, iso, subject] = out.trim().split("\0");
    if (!hash) return null;
    return { hash, shortHash, author, date: new Date(iso), subject };
  } catch {
    return null;
  }
}

/** Find and read the README in a directory, if any. */
export async function findReadme(
  name: string,
  ref: string,
  subpath: string,
): Promise<{ name: string; text: string } | null> {
  const entries = await listDirectory(name, ref, subpath);
  if (!entries) return null;

  const byLower = new Map(entries.filter((e) => e.type === "blob").map((e) => [e.name.toLowerCase(), e]));
  let target: TreeEntry | undefined;
  for (const candidate of README_NAMES) {
    const hit = byLower.get(candidate.toLowerCase());
    if (hit) {
      target = hit;
      break;
    }
  }
  if (!target) return null;

  const blob = await readBlob(name, ref, target.path);
  if (!blob || blob.text === null) return null;
  return { name: target.name, text: blob.text };
}
