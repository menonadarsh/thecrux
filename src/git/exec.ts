import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";

const pexec = promisify(execFile);

/** Largest object we will read into memory. */
export const MAX_BUFFER = 64 * 1024 * 1024;

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SHA_RE = /^[0-9a-fA-F]{4,64}$/;

/** Repository name segment (no slashes). */
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** Owner / username segment. */
export const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}$/;

export function isValidRepoName(name: string): boolean {
  return NAME_RE.test(name) && !name.endsWith(".git");
}

export function isValidOwner(owner: string): boolean {
  return OWNER_RE.test(owner);
}

/** Namespace names that collide with top-level routes and can't be claimed. */
const RESERVED_NAMESPACES = new Set([
  "new",
  "orgs",
  "login",
  "logout",
  "register",
  "settings",
  "admin",
  "api",
  "healthz",
]);

export function isReservedNamespace(name: string): boolean {
  return RESERVED_NAMESPACES.has(name.toLowerCase());
}

export interface RepoRef {
  owner: string;
  name: string;
}

/** Parse an "owner/name" slug into its parts, or null if invalid. */
export function parseRepoRef(slug: string): RepoRef | null {
  const parts = slug.split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (!isValidOwner(owner) || !isValidRepoName(name)) return null;
  return { owner, name };
}

/** Absolute path to a repo's bare directory: <reposDir>/<owner>/<name>.git. */
export function repoDirFor(owner: string, name: string): string {
  return path.join(config.reposDir, owner, `${name}.git`);
}

/** Resolve an "owner/name" slug to its existing bare directory, or null. */
export function repoDir(slug: string): string | null {
  const ref = parseRepoRef(slug);
  if (!ref) return null;
  const dir = repoDirFor(ref.owner, ref.name);
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
