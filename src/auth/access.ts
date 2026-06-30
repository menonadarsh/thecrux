import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { parseRepoRef, repoDir } from "../git/exec.js";
import { writeJsonAtomic } from "../util/atomic.js";
import { isOrg, isOrgMember, isOrgOwner } from "./orgs.js";

/**
 * Per-repository access control.
 *
 * - The repo **owner** (its namespace) has admin rights.
 * - **Collaborators** (stored in `crux-collaborators.json`) have write access.
 * - **Visibility** (a `crux-private` marker file) decides who may read: public
 *   repos are world-readable; private repos are visible only to the owner and
 *   collaborators.
 */

function collabPath(slug: string): string | null {
  const dir = repoDir(slug);
  return dir ? path.join(dir, "crux-collaborators.json") : null;
}

function privatePath(slug: string): string | null {
  const dir = repoDir(slug);
  return dir ? path.join(dir, "crux-private") : null;
}

/** True if the repo is private (its `crux-private` marker exists). */
export function isPrivate(slug: string): boolean {
  const file = privatePath(slug);
  if (!file) return false;
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Set a repo's visibility by creating/removing its `crux-private` marker. */
export async function setPrivate(slug: string, value: boolean): Promise<void> {
  const file = privatePath(slug);
  if (!file) return;
  if (value) {
    await fsp.writeFile(file, "1\n", "utf8");
  } else {
    await fsp.rm(file, { force: true });
  }
}

function archivedPath(slug: string): string | null {
  const dir = repoDir(slug);
  return dir ? path.join(dir, "crux-archived") : null;
}

/** True if the repo is archived (read-only — pushes are refused). */
export function isArchived(slug: string): boolean {
  const file = archivedPath(slug);
  if (!file) return false;
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Archive or unarchive a repo via its `crux-archived` marker. */
export async function setArchived(slug: string, value: boolean): Promise<void> {
  const file = archivedPath(slug);
  if (!file) return;
  if (value) {
    await fsp.writeFile(file, "1\n", "utf8");
  } else {
    await fsp.rm(file, { force: true });
  }
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
  await writeJsonAtomic(file, list);
}

/**
 * True if `username` has owner (admin) rights on the repo: the personal
 * namespace matches the user, or — for an org namespace — the user is an org
 * owner.
 */
export function isOwner(slug: string, username: string | undefined | null): boolean {
  const ref = parseRepoRef(slug);
  if (!ref || !username) return false;
  if (eq(ref.owner, username)) return true;
  return isOrg(ref.owner) && isOrgOwner(ref.owner, username);
}

/**
 * True if `username` may write to the repo: an owner (above), a repo
 * collaborator, or — for an org namespace — any org member.
 */
export function canWrite(slug: string, username: string | undefined | null): boolean {
  if (!username) return false;
  if (isOwner(slug, username)) return true;
  if (listCollaborators(slug).some((c) => eq(c, username))) return true;
  const ref = parseRepoRef(slug);
  return !!ref && isOrg(ref.owner) && isOrgMember(ref.owner, username);
}

/** True if `username` may read the repo (always for public; members for private). */
export function canRead(slug: string, username: string | undefined | null): boolean {
  if (!isPrivate(slug)) return true;
  return canWrite(slug, username);
}

/**
 * Read check against an already-loaded summary, avoiding a second stat. Accepts
 * any object exposing `slug` and `private` (e.g. a RepoSummary).
 */
export function canReadSummary(
  repo: { slug: string; private: boolean },
  username: string | undefined | null,
): boolean {
  return !repo.private || canWrite(repo.slug, username);
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
