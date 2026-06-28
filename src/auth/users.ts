import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

export interface User {
  username: string;
  displayName: string;
  passwordHash: string;
  createdAt: string;
}

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
  const user: User = {
    username: name,
    displayName: (displayName ?? name).trim() || name,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
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
