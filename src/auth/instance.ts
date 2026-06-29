import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { writeJsonAtomic } from "../util/atomic.js";

/**
 * Instance-wide settings (registration policy + invite tokens), persisted as a
 * single `instance.json` in the data dir — no database, consistent with how
 * users and repo metadata are stored.
 *
 * Registration policy:
 *   - "open"   anyone may create an account
 *   - "invite" a valid single-use invite token is required
 *   - "closed" no new accounts (except the bootstrap account on a fresh instance)
 */

export type RegistrationPolicy = "open" | "invite" | "closed";
const POLICIES: RegistrationPolicy[] = ["open", "invite", "closed"];

export interface Invite {
  token: string;
  createdBy: string;
  createdAt: string;
  note?: string;
}

interface InstanceSettings {
  registration: RegistrationPolicy;
  invites: Invite[];
}

const FILE = path.join(config.dataDir, "instance.json");

let settings: InstanceSettings | null = null;

function load(): InstanceSettings {
  if (settings) return settings;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    settings = {
      registration: isRegistrationPolicy(parsed.registration) ? parsed.registration : "open",
      invites: Array.isArray(parsed.invites) ? parsed.invites : [],
    };
  } catch {
    settings = { registration: "open", invites: [] };
  }
  return settings;
}

async function persist(): Promise<void> {
  await fsp.mkdir(config.dataDir, { recursive: true });
  await writeJsonAtomic(FILE, settings);
}

export function isRegistrationPolicy(v: unknown): v is RegistrationPolicy {
  return typeof v === "string" && (POLICIES as string[]).includes(v);
}

export function getRegistrationPolicy(): RegistrationPolicy {
  return load().registration;
}

export async function setRegistrationPolicy(policy: RegistrationPolicy): Promise<void> {
  load().registration = policy;
  await persist();
}

/** Invites, most recent first. */
export function listInvites(): Invite[] {
  return [...load().invites].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createInvite(createdBy: string, note?: string): Promise<Invite> {
  const invite: Invite = {
    token: randomBytes(16).toString("base64url"),
    createdBy,
    createdAt: new Date().toISOString(),
    note: note?.trim() || undefined,
  };
  load().invites.push(invite);
  await persist();
  return invite;
}

export async function revokeInvite(token: string): Promise<void> {
  const s = load();
  s.invites = s.invites.filter((i) => i.token !== token);
  await persist();
}

export function inviteValid(token: string | undefined | null): boolean {
  return !!token && load().invites.some((i) => i.token === token);
}

/** Redeem a single-use invite. Returns true if it was valid (and now spent). */
export async function consumeInvite(token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  const s = load();
  const idx = s.invites.findIndex((i) => i.token === token);
  if (idx < 0) return false;
  s.invites.splice(idx, 1);
  await persist();
  return true;
}
