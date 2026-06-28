import { gitText, repoDir } from "./exec.js";

const NUL = "\x00";

export interface RefInfo {
  name: string;
  /** Short hash of the commit the ref points at. */
  shortHash: string;
  date: Date | null;
  subject: string;
  /** Tags only: whether this is an annotated tag object. */
  annotated?: boolean;
}

function toDate(iso: string): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** List branches, most-recently-updated first. */
export async function listBranches(name: string): Promise<RefInfo[] | null> {
  const dir = repoDir(name);
  if (!dir) return null;
  const fmt = [
    "%(refname:short)",
    "%(objectname:short)",
    "%(committerdate:iso-strict)",
    "%(contents:subject)",
  ].join("%00");
  try {
    const out = await gitText(dir, [
      "for-each-ref",
      "--sort=-committerdate",
      `--format=${fmt}`,
      "refs/heads",
    ]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [refName, shortHash, date, subject] = line.split(NUL);
        return { name: refName, shortHash, date: toDate(date), subject: subject ?? "" };
      });
  } catch {
    return null;
  }
}

/** List tags, newest first. Annotated tags are dereferenced to their commit. */
export async function listTags(name: string): Promise<RefInfo[] | null> {
  const dir = repoDir(name);
  if (!dir) return null;
  const fmt = [
    "%(refname:short)",
    "%(objectname:short)", // tag object (or commit for lightweight)
    "%(*objectname:short)", // dereferenced commit for annotated, else empty
    "%(creatordate:iso-strict)",
    "%(contents:subject)",
    "%(objecttype)",
  ].join("%00");
  try {
    const out = await gitText(dir, [
      "for-each-ref",
      "--sort=-creatordate",
      `--format=${fmt}`,
      "refs/tags",
    ]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [refName, obj, derefObj, date, subject, type] = line.split(NUL);
        return {
          name: refName,
          shortHash: derefObj || obj,
          date: toDate(date),
          subject: subject ?? "",
          annotated: type === "tag",
        };
      });
  } catch {
    return null;
  }
}

/** Lightweight list of just branch and tag names, for the ref switcher. */
export async function listRefNames(
  name: string,
): Promise<{ branches: string[]; tags: string[] }> {
  const dir = repoDir(name);
  if (!dir) return { branches: [], tags: [] };
  try {
    const out = await gitText(dir, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/heads",
      "refs/tags",
    ]);
    const branches: string[] = [];
    const tags: string[] = [];
    for (const line of out.split("\n")) {
      if (line.startsWith("refs/heads/")) branches.push(line.slice("refs/heads/".length));
      else if (line.startsWith("refs/tags/")) tags.push(line.slice("refs/tags/".length));
    }
    return { branches, tags };
  } catch {
    return { branches: [], tags: [] };
  }
}
