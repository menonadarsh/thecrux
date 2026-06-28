import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export const SESSION_COOKIE = "crux_session";
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Load the signing secret from env or a persisted file, generating one if needed. */
function loadSecret(): string {
  if (process.env.CRUX_SECRET) return process.env.CRUX_SECRET;
  const file = path.join(config.dataDir, "secret");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    // not yet created
  }
  const secret = randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
  } catch {
    // fall back to an in-memory secret (sessions won't survive a restart)
  }
  return secret;
}

const SECRET = loadSecret();

function sign(payload: string): string {
  return createHmac("sha256", SECRET).update(payload).digest("base64url");
}

/** Create a signed session token for a username. */
export function createSession(username: string): string {
  const payload = Buffer.from(`${username}|${Date.now() + SESSION_MAX_AGE_MS}`).toString(
    "base64url",
  );
  return `${payload}.${sign(payload)}`;
}

/** Verify a session token and return the username, or null if invalid/expired. */
export function readSession(token: string | undefined): string | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const [username, expStr] = Buffer.from(payload, "base64url").toString("utf8").split("|");
    if (!username || Date.now() > Number(expStr)) return null;
    return username;
  } catch {
    return null;
  }
}
