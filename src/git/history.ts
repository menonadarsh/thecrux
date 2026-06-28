import { cleanSubpath, gitText, repoDir, safeRef, safeSha } from "./exec.js";

// Real bytes used to split git's output. The format strings below use git's
// own %x00 / %x1e placeholders so argv never contains literal null bytes
// (execFile rejects those).
const NUL = "\x00";
const RS = "\x1e";

export interface LogEntry {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: Date;
  subject: string;
}

export interface LogPage {
  commits: LogEntry[];
  hasMore: boolean;
  skip: number;
  limit: number;
}

export type DiffLineKind = "hunk" | "ctx" | "add" | "del" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface FileDiff {
  path: string;
  oldPath: string | null;
  status: "added" | "deleted" | "modified" | "renamed";
  binary: boolean;
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

export interface CommitDetail {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: Date;
  subject: string;
  body: string;
  parents: string[];
  files: FileDiff[];
  additions: number;
  deletions: number;
}

const LOG_FORMAT = ["%H", "%h", "%an", "%ae", "%aI", "%s"].join("%x00") + "%x1e";

/** List commits reachable from a ref, newest first, with pagination. */
export async function listCommits(
  name: string,
  ref: string,
  opts: { skip?: number; limit?: number; path?: string } = {},
): Promise<LogPage | null> {
  const dir = repoDir(name);
  const safe = safeRef(ref);
  if (!dir || !safe) return null;

  const skip = Math.max(0, opts.skip ?? 0);
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const path = cleanSubpath(opts.path ?? "");

  const args = [
    "log",
    `--format=${LOG_FORMAT}`,
    `--skip=${skip}`,
    `-n`,
    String(limit + 1), // fetch one extra to detect more pages
    safe,
  ];
  if (path) args.push("--", path);

  let out: string;
  try {
    out = await gitText(dir, args);
  } catch {
    return null;
  }

  const records = out.split(RS).map((r) => r.trim()).filter(Boolean);
  const commits: LogEntry[] = records.map((rec) => {
    const [hash, shortHash, author, email, iso, subject] = rec.split(NUL);
    return { hash, shortHash, author, email, date: new Date(iso), subject };
  });

  const hasMore = commits.length > limit;
  if (hasMore) commits.pop();

  return { commits, hasMore, skip, limit };
}

/** Strip a leading "a/" or "b/" prefix from a diff path. */
function stripPrefix(p: string): string {
  return p.replace(/^[ab]\//, "");
}

/** Parse a unified diff (output of `git show -p`) into per-file structures. */
export function parseDiff(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let oldNo = 0;
  let newNo = 0;

  const push = () => {
    if (current) files.push(current);
  };

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      push();
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const path = m ? m[2] : "";
      current = {
        path,
        oldPath: m && m[1] !== m[2] ? m[1] : null,
        status: "modified",
        binary: false,
        additions: 0,
        deletions: 0,
        lines: [],
      };
      continue;
    }
    if (!current) continue;

    if (line.startsWith("new file mode")) {
      current.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.status = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.oldPath = line.slice("rename from ".length);
      current.status = "renamed";
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.path = line.slice("rename to ".length);
      current.status = "renamed";
      continue;
    }
    if (line.startsWith("Binary files")) {
      current.binary = true;
      continue;
    }
    if (line.startsWith("--- ")) {
      const p = line.slice(4);
      if (p !== "/dev/null") current.oldPath = current.oldPath ?? stripPrefix(p);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4);
      if (p !== "/dev/null") current.path = stripPrefix(p);
      continue;
    }
    if (line.startsWith("index ") || line.startsWith("old mode") || line.startsWith("new mode") || line.startsWith("similarity index")) {
      continue;
    }
    if (line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[2]);
      }
      current.lines.push({ kind: "hunk", text: line, oldNo: null, newNo: null });
      continue;
    }
    if (line.startsWith("\\")) {
      // e.g. "\ No newline at end of file"
      current.lines.push({ kind: "meta", text: line, oldNo: null, newNo: null });
      continue;
    }
    if (line.startsWith("+")) {
      current.lines.push({ kind: "add", text: line.slice(1), oldNo: null, newNo: newNo++ });
      current.additions++;
      continue;
    }
    if (line.startsWith("-")) {
      current.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++, newNo: null });
      current.deletions++;
      continue;
    }
    if (line.startsWith(" ")) {
      current.lines.push({ kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
      continue;
    }
    // ignore blank trailing lines between files
  }
  push();
  return files;
}

/** Full details of a single commit, including its diff against the first parent. */
export async function getCommit(name: string, sha: string): Promise<CommitDetail | null> {
  const dir = repoDir(name);
  const safe = safeSha(sha);
  if (!dir || !safe) return null;

  const metaFormat = ["%H", "%h", "%an", "%ae", "%aI", "%P", "%s", "%b"].join("%x00");
  let metaOut: string;
  try {
    metaOut = await gitText(dir, ["show", "-s", `--format=${metaFormat}`, safe]);
  } catch {
    return null;
  }
  const [hash, shortHash, author, email, iso, parentStr, subject, body] = metaOut.split(NUL);
  if (!hash) return null;
  const parents = parentStr.trim() ? parentStr.trim().split(" ") : [];

  // Patch (against first parent for merges, to keep the diff parseable).
  let patch = "";
  try {
    patch = await gitText(dir, [
      "show",
      "--patch",
      "--first-parent",
      "--no-color",
      "--format=",
      safe,
    ]);
  } catch {
    patch = "";
  }

  const files = parseDiff(patch);
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);

  return {
    hash,
    shortHash,
    author,
    email,
    date: new Date(iso),
    subject,
    body: (body ?? "").trim(),
    parents,
    files,
    additions,
    deletions,
  };
}
