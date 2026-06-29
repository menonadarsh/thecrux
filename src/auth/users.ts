import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

/** A personal access token, used to authenticate git-over-HTTP. */
export interface ApiToken {
  /** Random id, used to revoke the token. */
  id: string;
  /** User-chosen label. */
  name: string;
  /** SHA-256 of the secret (the secret itself is shown only once, at creation). */
  hash: string;
  /** Last 4 chars of the secret, for display (e.g. crux_pat_…a1b2). */
  tail: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface User {
  username: string;
  displayName: string;
  passwordHash: string;
  createdAt: string;
  /** Instance administrator. The first registered user is made admin. */
  admin?: boolean;
  /** Personal access tokens for git-over-HTTP. */
  tokens?: ApiToken[];
}

/** Prefix that marks a string as one of our personal access tokens. */
export const TOKEN_PREFIX = "crux_pat_";

export class AuthError extends Error {}

const USERS_FILE = path.join(config.dataDir, "users.json");
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,38}$/;

let users: Record<string, User> | null = null;

function load(): Record<string, User> {
  if (users) return users;
  try {
    users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch {
    users = {};
  }
  return users!;
}

async function persist(): Promise<void> {
  await fsp.mkdir(config.dataDir, { recursive: true });
  await fsp.writeFile(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

function checkPassword(password: string, stored: string): boolean {
  const [scheme, salt, derived] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !derived) return false;
  const test = scryptSync(password, salt, 64);
  const orig = Buffer.from(derived, "hex");
  return test.length === orig.length && timingSafeEqual(test, orig);
}

export function getUser(username: string): User | null {
  return load()[username.toLowerCase()] ?? null;
}

export function userCount(): number {
  return Object.keys(load()).length;
}

/** Create a new account. Throws AuthError on invalid/duplicate input. */
export async function createUser(
  username: string,
  password: string,
  displayName?: string,
): Promise<User> {
  const name = username.trim();
  if (!USERNAME_RE.test(name)) {
    throw new AuthError(
      "Username must be 2–39 chars: letters, numbers, '.', '_' or '-', and start alphanumeric.",
    );
  }
  if (password.length < 8) {
    throw new AuthError("Password must be at least 8 characters.");
  }
  const store = load();
  if (store[name.toLowerCase()]) {
    throw new AuthError(`Username '${name}' is taken.`);
  }
  // The very first account on a fresh instance becomes its administrator.
  const isFirst = Object.keys(store).length === 0;
  const user: User = {
    username: name,
    displayName: (displayName ?? name).trim() || name,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
    admin: isFirst ? true : undefined,
  };
  store[name.toLowerCase()] = user;
  await persist();
  return user;
}

/** Return the user if the password matches, else null. */
export function authenticate(username: string, password: string): User | null {
  const user = getUser(username);
  if (!user) return null;
  return checkPassword(password, user.passwordHash) ? user : null;
}

/** True if the named user is an instance administrator. */
export function isAdmin(username: string | undefined | null): boolean {
  return !!username && getUser(username)?.admin === true;
}

/** All users, oldest first. */
export function listUsers(): User[] {
  return Object.values(load()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Number of administrators (used to refuse demoting the last one). */
export function adminCount(): number {
  return Object.values(load()).filter((u) => u.admin).length;
}

/** Grant or revoke admin rights. No-op if the user doesn't exist. */
export async function setAdmin(username: string, value: boolean): Promise<void> {
  const user = load()[username.toLowerCase()];
  if (!user) return;
  if (value) user.admin = true;
  else delete user.admin;
  await persist();
}

/** SHA-256 hex of a token secret (tokens are high-entropy, so a fast hash is fine). */
function tokenHash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** A user's tokens (metadata only — never the secret). */
export function listTokens(username: string): ApiToken[] {
  return getUser(username)?.tokens ?? [];
}

/**
 * Create a personal access token for a user. Returns the one-time plaintext
 * secret (shown to the user once) and the stored record. No-op-safe: throws
 * AuthError if the user is unknown or the name is blank.
 */
export async function createToken(
  username: string,
  name: string,
): Promise<{ secret: string; token: ApiToken }> {
  const user = load()[username.toLowerCase()];
  if (!user) throw new AuthError("Unknown user.");
  const label = name.trim();
  if (!label) throw new AuthError("Give the token a name so you can recognize it later.");

  const secret = TOKEN_PREFIX + randomBytes(24).toString("base64url");
  const token: ApiToken = {
    id: randomBytes(8).toString("hex"),
    name: label,
    hash: tokenHash(secret),
    tail: secret.slice(-4),
    createdAt: new Date().toISOString(),
  };
  (user.tokens ??= []).push(token);
  await persist();
  return { secret, token };
}

/** Revoke a token by id. No-op if not found. */
export async function revokeToken(username: string, id: string): Promise<void> {
  const user = load()[username.toLowerCase()];
  if (!user?.tokens) return;
  user.tokens = user.tokens.filter((t) => t.id !== id);
  await persist();
}

/** Resolve the owner of a token secret, or null. Updates lastUsedAt (throttled). */
export function findUserByToken(secret: string | undefined | null): User | null {
  if (!secret || !secret.startsWith(TOKEN_PREFIX)) return null;
  const hash = tokenHash(secret);
  for (const user of Object.values(load())) {
    const token = user.tokens?.find((t) => t.hash === hash);
    if (token) {
      touchToken(token);
      return user;
    }
  }
  return null;
}

/**
 * Record token usage, but persist at most once an hour to avoid a disk write on
 * every git request. Best-effort — failures are ignored.
 */
function touchToken(token: ApiToken): void {
  const now = Date.now();
  const last = token.lastUsedAt ? Date.parse(token.lastUsedAt) : 0;
  if (now - last < 60 * 60 * 1000) return;
  token.lastUsedAt = new Date(now).toISOString();
  void persist().catch(() => {});
}
