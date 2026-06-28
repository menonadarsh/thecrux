import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);

export interface RepoSummary {
  name: string;
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

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Validate a repository name and return its normalized form. */
export function normalizeRepoName(raw: string): string {
  const name = raw.trim();
  if (!NAME_RE.test(name)) {
    throw new RepoError(
      "Invalid repository name. Use letters, numbers, '.', '_' or '-' (max 100 chars).",
    );
  }
  if (name.endsWith(".git")) {
    throw new RepoError("Repository name should not include the '.git' suffix.");
  }
  return name;
}

/** Absolute path to a repo's bare git directory (`<name>.git`). */
function repoPath(name: string): string {
  return path.join(config.reposDir, `${name}.git`);
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

/** Create a new bare repository. */
export async function createRepo(rawName: string, description = ""): Promise<RepoSummary> {
  const name = normalizeRepoName(rawName);
  const dir = repoPath(name);

  if (await exists(dir)) {
    throw new RepoError(`A repository named '${name}' already exists.`, 409);
  }

  await fs.mkdir(dir, { recursive: true });
  // Bare repo with a modern default branch so HTTP clone/push work out of the box.
  await git(dir, ["init", "--bare", "--initial-branch=main", "."]);

  if (description.trim()) {
    await fs.writeFile(path.join(dir, "description"), `${description.trim()}\n`, "utf8");
  }
  // Allow dumb-HTTP fetch as a fallback and keep server info fresh.
  await git(dir, ["update-server-info"]).catch(() => {});

  return (await getRepo(name))!;
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
  // HEAD symbolic ref, e.g. "refs/heads/main".
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

/** Fetch a single repo's summary, or null if it does not exist. */
export async function getRepo(name: string): Promise<RepoSummary | null> {
  let cleanName: string;
  try {
    cleanName = normalizeRepoName(name);
  } catch {
    return null;
  }
  const dir = repoPath(cleanName);
  if (!(await exists(dir))) return null;

  const [{ defaultBranch, empty }, description, stat] = await Promise.all([
    readHead(dir),
    readDescription(dir),
    fs.stat(dir),
  ]);

  return { name: cleanName, description, empty, defaultBranch, updatedAt: stat.mtime };
}

/** List all hosted repositories, most recently updated first. */
export async function listRepos(): Promise<RepoSummary[]> {
  await ensureReposDir();
  const entries = await fs.readdir(config.reposDir, { withFileTypes: true });
  const names = entries
    .filter((e) => e.isDirectory() && e.name.endsWith(".git"))
    .map((e) => e.name.replace(/\.git$/, ""));

  const repos = await Promise.all(names.map((n) => getRepo(n)));
  return repos
    .filter((r): r is RepoSummary => r !== null)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}
