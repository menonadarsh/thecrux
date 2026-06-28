import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseDiff, type FileDiff } from "./history.js";
import { gitText, repoDir, safeRef, MAX_BUFFER } from "./exec.js";

const execFileAsync = promisify(execFile);

const LOG_FMT = ["%H", "%h", "%an", "%aI", "%s"].join("%x00") + "%x1e";

export interface CompareCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: Date;
  subject: string;
}

export interface Comparison {
  base: string;
  head: string;
  baseSha: string;
  headSha: string;
  commits: CompareCommit[];
  files: FileDiff[];
  additions: number;
  deletions: number;
  /** head has no commits beyond base. */
  identical: boolean;
  /** base can fast-forward to head. */
  fastForward: boolean;
}

export interface MergeResult {
  ok: boolean;
  fastForward?: boolean;
  conflict?: boolean;
  sha?: string;
  reason?: string;
}

function parseLog(out: string): CompareCommit[] {
  return out
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((rec) => {
      const [hash, shortHash, author, iso, subject] = rec.split("\x00");
      return { hash, shortHash, author, date: new Date(iso), subject };
    });
}

/** Resolve a ref to a commit SHA, or null. */
async function resolve(dir: string, ref: string): Promise<string | null> {
  try {
    return (await gitText(dir, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
  } catch {
    return null;
  }
}

/** True if `a` is an ancestor of `b`. */
async function isAncestor(dir: string, a: string, b: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", dir, "merge-base", "--is-ancestor", a, b]);
    return true;
  } catch {
    return false;
  }
}

/** Compare two refs: commits on head not in base, plus the three-dot diff. */
export async function compareRefs(
  name: string,
  base: string,
  head: string,
): Promise<Comparison | null> {
  const dir = repoDir(name);
  const b = safeRef(base);
  const h = safeRef(head);
  if (!dir || !b || !h) return null;

  const baseSha = await resolve(dir, b);
  const headSha = await resolve(dir, h);
  if (!baseSha || !headSha) return null;

  let commits: CompareCommit[] = [];
  try {
    commits = parseLog(await gitText(dir, ["log", `--format=${LOG_FMT}`, `${b}..${h}`]));
  } catch {
    commits = [];
  }

  let files: FileDiff[] = [];
  try {
    files = parseDiff(await gitText(dir, ["diff", "--no-color", `${b}...${h}`]));
  } catch {
    files = [];
  }

  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);

  return {
    base: b,
    head: h,
    baseSha,
    headSha,
    commits,
    files,
    additions,
    deletions,
    identical: commits.length === 0,
    fastForward: await isAncestor(dir, baseSha, headSha),
  };
}

export type Mergeability = "identical" | "ff" | "clean" | "conflict";

/** Classify how a comparison would merge, without changing anything. */
export async function mergeability(name: string, comp: Comparison): Promise<Mergeability> {
  if (comp.identical) return "identical";
  if (comp.fastForward) return "ff";
  const dir = repoDir(name);
  if (!dir) return "conflict";
  try {
    await gitText(dir, ["merge-tree", "--write-tree", comp.baseSha, comp.headSha]);
    return "clean";
  } catch {
    return "conflict";
  }
}

/** Merge head into the base *branch*, writing the result to the bare repo. */
export async function mergeRefs(
  name: string,
  base: string,
  head: string,
  message: string,
  author: { name: string; email: string },
): Promise<MergeResult> {
  const dir = repoDir(name);
  const b = safeRef(base);
  const h = safeRef(head);
  if (!dir || !b || !h) return { ok: false, reason: "invalid refs" };

  const baseSha = await resolve(dir, b);
  const headSha = await resolve(dir, h);
  if (!baseSha || !headSha) return { ok: false, reason: "could not resolve refs" };

  // Nothing to do if head is already contained in base.
  if (await isAncestor(dir, headSha, baseSha)) {
    return { ok: false, reason: "already merged" };
  }

  const baseRef = `refs/heads/${b}`;

  // Fast-forward when base is an ancestor of head.
  if (await isAncestor(dir, baseSha, headSha)) {
    await gitText(dir, ["update-ref", baseRef, headSha, baseSha]);
    return { ok: true, fastForward: true, sha: headSha };
  }

  // True merge via plumbing: build the merged tree, then a merge commit.
  let tree: string;
  try {
    const out = await gitText(dir, ["merge-tree", "--write-tree", baseSha, headSha]);
    tree = out.trim().split("\n")[0];
  } catch {
    // Non-zero exit from merge-tree means conflicts.
    return { ok: false, conflict: true };
  }

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  };
  const { stdout } = await execFileAsync(
    "git",
    ["-C", dir, "commit-tree", tree, "-p", baseSha, "-p", headSha, "-m", message],
    { env, maxBuffer: MAX_BUFFER },
  );
  const commit = (stdout as string).trim();
  await gitText(dir, ["update-ref", baseRef, commit, baseSha]);
  await execFileAsync("git", ["-C", dir, "update-server-info"]).catch(() => {});
  return { ok: true, fastForward: false, sha: commit };
}
