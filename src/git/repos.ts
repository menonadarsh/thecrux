import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";
import { isValidOwner, isValidRepoName, parseRepoRef, repoDirFor } from "./exec.js";

const execFileAsync = promisify(execFile);

export interface RepoSummary {
  name: string;
  /** Owner (namespace) the repo lives under. */
  owner: string;
  /** Convenience "owner/name" identifier. */
  slug: string;
  description: string;
  /** Whether the repo has any commits yet. */
  empty: boolean;
  /** Default branch name, or null if empty. */
  defaultBranch: string | null;
  updatedAt: Date;
}

export class RepoError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "RepoError";
  }
}

/** Owner used for legacy flat repos migrated into the namespaced layout. */
const LEGACY_OWNER = "legacy";

/** Validate a repository name and return its normalized form. */
export function normalizeRepoName(raw: string): string {
  const name = raw.trim();
  if (name.endsWith(".git")) {
    throw new RepoError("Repository name should not include the '.git' suffix.");
  }
  if (!isValidRepoName(name)) {
    throw new RepoError(
      "Invalid repository name. Use letters, numbers, '.', '_' or '-' (max 100 chars).",
    );
  }
  return name;
}

/** Validate an owner/username and return its normalized form. */
export function normalizeOwner(raw: string): string {
  const owner = raw.trim();
  if (!isValidOwner(owner)) {
    throw new RepoError("Invalid owner name.");
  }
  return owner;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Ensure the repositories directory exists. */
export async function ensureReposDir(): Promise<void> {
  await fs.mkdir(config.reposDir, { recursive: true });
}

/** Create a new bare repository under an owner's namespace. */
export async function createRepo(
  rawOwner: string,
  rawName: string,
  description = "",
): Promise<RepoSummary> {
  const owner = normalizeOwner(rawOwner);
  const name = normalizeRepoName(rawName);
  const dir = repoDirFor(owner, name);

  if (await exists(dir)) {
    throw new RepoError(`A repository named '${owner}/${name}' already exists.`, 409);
  }

  await fs.mkdir(dir, { recursive: true });
  // Bare repo with a modern default branch so HTTP clone/push work out of the box.
  await git(dir, ["init", "--bare", "--initial-branch=main", "."]);

  if (description.trim()) {
    await fs.writeFile(path.join(dir, "description"), `${description.trim()}\n`, "utf8");
  }
  await fs.writeFile(path.join(dir, "crux-owner"), `${owner}\n`, "utf8");
  // Allow dumb-HTTP fetch as a fallback and keep server info fresh.
  await git(dir, ["update-server-info"]).catch(() => {});

  return (await getRepo(`${owner}/${name}`))!;
}

/** Read the description file for a repo, if meaningful. */
async function readDescription(dir: string): Promise<string> {
  try {
    const text = (await fs.readFile(path.join(dir, "description"), "utf8")).trim();
    // git writes a default placeholder; treat it as empty.
    if (!text || text.startsWith("Unnamed repository")) return "";
    return text;
  } catch {
    return "";
  }
}

/** Resolve the default branch (HEAD) and whether the repo has commits. */
async function readHead(dir: string): Promise<{ defaultBranch: string | null; empty: boolean }> {
  let defaultBranch: string | null = null;
  try {
    const ref = (await git(dir, ["symbolic-ref", "HEAD"])).trim();
    defaultBranch = ref.replace(/^refs\/heads\//, "") || null;
  } catch {
    defaultBranch = null;
  }

  let empty = true;
  try {
    await git(dir, ["rev-parse", "--verify", "HEAD"]);
    empty = false;
  } catch {
    empty = true;
  }

  return { defaultBranch, empty };
}

/** Fetch a single repo's summary by "owner/name" slug, or null. */
export async function getRepo(slug: string): Promise<RepoSummary | null> {
  const ref = parseRepoRef(slug);
  if (!ref) return null;
  const dir = repoDirFor(ref.owner, ref.name);
  if (!(await exists(dir))) return null;

  const [{ defaultBranch, empty }, description, stat] = await Promise.all([
    readHead(dir),
    readDescription(dir),
    fs.stat(dir),
  ]);

  return {
    name: ref.name,
    owner: ref.owner,
    slug: `${ref.owner}/${ref.name}`,
    description,
    empty,
    defaultBranch,
    updatedAt: stat.mtime,
  };
}

/** List the repos owned by a single owner. */
export async function listReposByOwner(owner: string): Promise<RepoSummary[]> {
  if (!isValidOwner(owner)) return [];
  const ownerDir = path.join(config.reposDir, owner);
  let entries;
  try {
    entries = await fs.readdir(ownerDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries
    .filter((e) => e.isDirectory() && e.name.endsWith(".git"))
    .map((e) => e.name.replace(/\.git$/, ""));
  const repos = await Promise.all(names.map((n) => getRepo(`${owner}/${n}`)));
  return repos
    .filter((r): r is RepoSummary => r !== null)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/** List all hosted repositories, most recently updated first. */
export async function listRepos(): Promise<RepoSummary[]> {
  await ensureReposDir();
  const owners = await fs.readdir(config.reposDir, { withFileTypes: true });
  const ownerNames = owners
    .filter((e) => e.isDirectory() && !e.name.endsWith(".git") && isValidOwner(e.name))
    .map((e) => e.name);

  const lists = await Promise.all(ownerNames.map((o) => listReposByOwner(o)));
  return lists
    .flat()
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/**
 * One-time migration: relocate legacy flat repos (`<reposDir>/<name>.git`) into
 * the namespaced layout (`<reposDir>/<owner>/<name>.git`). The owner comes from
 * the repo's `crux-owner` file, falling back to "legacy". Idempotent.
 */
export async function migrateFlatRepos(): Promise<void> {
  await ensureReposDir();
  let entries;
  try {
    entries = await fs.readdir(config.reposDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".git")) continue;
    const name = entry.name.replace(/\.git$/, "");
    if (!isValidRepoName(name)) continue;
    const flatDir = path.join(config.reposDir, entry.name);

    let owner = LEGACY_OWNER;
    try {
      const recorded = (await fs.readFile(path.join(flatDir, "crux-owner"), "utf8")).trim();
      if (recorded && isValidOwner(recorded)) owner = recorded;
    } catch {
      // no recorded owner — use legacy
    }

    const targetDir = repoDirFor(owner, name);
    if (await exists(targetDir)) continue; // would collide; leave as-is
    await fs.mkdir(path.dirname(targetDir), { recursive: true });
    await fs.rename(flatDir, targetDir);
    console.log(`migrated repo '${name}' -> '${owner}/${name}'`);
  }
}
