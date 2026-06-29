import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { parseRepoRef, repoDir } from "../git/exec.js";

/**
 * Per-repository access control.
 *
 * - The repo **owner** (its namespace) has admin rights.
 * - **Collaborators** (stored in `crux-collaborators.json`) have write access.
 * - Everyone else has read-only access (browsing and cloning stay public).
 */

function collabPath(slug: string): string | null {
  const dir = repoDir(slug);
  return dir ? path.join(dir, "crux-collaborators.json") : null;
}

function eq(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** List the usernames granted write access to a repo. */
export function listCollaborators(slug: string): string[] {
  const file = collabPath(slug);
  if (!file) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(data) ? data.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function writeCollaborators(slug: string, list: string[]): Promise<void> {
  const file = collabPath(slug);
  if (!file) return;
  await fsp.writeFile(file, JSON.stringify(list, null, 2), "utf8");
}

/** True if `username` is the repo owner. */
export function isOwner(slug: string, username: string | undefined | null): boolean {
  const ref = parseRepoRef(slug);
  return !!ref && !!username && eq(ref.owner, username);
}

/** True if `username` may write to the repo (owner or collaborator). */
export function canWrite(slug: string, username: string | undefined | null): boolean {
  if (!username) return false;
  if (isOwner(slug, username)) return true;
  return listCollaborators(slug).some((c) => eq(c, username));
}

/** Add a collaborator (no-op if already present or is the owner). Returns the list. */
export async function addCollaborator(slug: string, username: string): Promise<string[]> {
  const name = username.trim();
  if (!name) return listCollaborators(slug);
  if (isOwner(slug, name)) return listCollaborators(slug);
  const list = listCollaborators(slug);
  if (!list.some((c) => eq(c, name))) {
    list.push(name);
    await writeCollaborators(slug, list);
  }
  return list;
}

/** Remove a collaborator. Returns the updated list. */
export async function removeCollaborator(slug: string, username: string): Promise<string[]> {
  const list = listCollaborators(slug).filter((c) => !eq(c, username));
  await writeCollaborators(slug, list);
  return list;
}
