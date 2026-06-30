import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { isReservedNamespace, isValidOwner } from "../git/exec.js";
import { writeJsonAtomic } from "../util/atomic.js";
import { AuthError, getUser } from "./users.js";

export type OrgRole = "owner" | "member";

/**
 * An organization — a shared repo namespace. Like a user it occupies a slot in
 * the global namespace (no user and org may share a name). Members map a
 * username to a role: owners administer the org and its repos; members can
 * write to all of its repos.
 */
export interface Org {
  name: string;
  displayName: string;
  createdAt: string;
  members: Record<string, OrgRole>;
}

const ORGS_FILE = path.join(config.dataDir, "orgs.json");

let orgs: Record<string, Org> | null = null;

function load(): Record<string, Org> {
  if (orgs) return orgs;
  try {
    orgs = JSON.parse(fs.readFileSync(ORGS_FILE, "utf8"));
  } catch {
    orgs = {};
  }
  return orgs!;
}

async function persist(): Promise<void> {
  await fs.promises.mkdir(config.dataDir, { recursive: true });
  await writeJsonAtomic(ORGS_FILE, orgs);
}

export function getOrg(name: string): Org | null {
  return load()[name.toLowerCase()] ?? null;
}

export function isOrg(name: string | undefined | null): boolean {
  return !!name && !!load()[name.toLowerCase()];
}

export function listOrgs(): Org[] {
  return Object.values(load()).sort((a, b) => a.name.localeCompare(b.name));
}

/** The role of a user in an org, or null if not a member. */
export function orgRole(name: string, username: string | undefined | null): OrgRole | null {
  if (!username) return null;
  const org = getOrg(name);
  if (!org) return null;
  // Member keys are stored lowercased for case-insensitive lookup.
  return org.members[username.toLowerCase()] ?? null;
}

export function isOrgOwner(name: string, username: string | undefined | null): boolean {
  return orgRole(name, username) === "owner";
}

export function isOrgMember(name: string, username: string | undefined | null): boolean {
  return orgRole(name, username) !== null;
}

/** Orgs the user belongs to (any role), for owner pickers and listings. */
export function orgsForUser(username: string | undefined | null): Org[] {
  if (!username) return [];
  const lc = username.toLowerCase();
  return listOrgs().filter((o) => o.members[lc] != null);
}

export function ownerCount(name: string): number {
  const org = getOrg(name);
  return org ? Object.values(org.members).filter((r) => r === "owner").length : 0;
}

/** Create an org owned by its creator. Throws AuthError on a bad/taken name. */
export async function createOrg(rawName: string, creator: string): Promise<Org> {
  const name = rawName.trim();
  if (!isValidOwner(name) || isReservedNamespace(name)) {
    throw new AuthError("Invalid or reserved organization name.");
  }
  const store = load();
  if (store[name.toLowerCase()]) throw new AuthError(`The name '${name}' is taken.`);
  if (getUser(name)) throw new AuthError(`The name '${name}' is taken by a user.`);

  const org: Org = {
    name,
    displayName: name,
    createdAt: new Date().toISOString(),
    members: { [creator.toLowerCase()]: "owner" },
  };
  store[name.toLowerCase()] = org;
  await persist();
  return org;
}


/** Add or update a member's role. Throws if the user doesn't exist. */
export async function setMember(name: string, username: string, role: OrgRole): Promise<void> {
  const org = load()[name.toLowerCase()];
  if (!org) return;
  const user = getUser(username);
  if (!user) throw new AuthError(`No such user '${username}'.`);
  org.members[user.username.toLowerCase()] = role;
  await persist();
}

/** Remove a member. Refuses to remove the last owner. */
export async function removeMember(name: string, username: string): Promise<void> {
  const org = load()[name.toLowerCase()];
  if (!org) return;
  const lc = username.toLowerCase();
  if (org.members[lc] === "owner" && ownerCount(name) <= 1) {
    throw new AuthError("Can't remove the last owner — promote someone else first.");
  }
  delete org.members[lc];
  await persist();
}

/** Delete an org. Caller must ensure it owns no repositories. */
export async function deleteOrg(name: string): Promise<void> {
  const store = load();
  delete store[name.toLowerCase()];
  await persist();
}
