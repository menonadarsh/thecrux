import type { NextFunction, Request, Response } from "express";
import { SESSION_COOKIE, readSession } from "./session.js";
import { authenticate, findUserByToken, getUser, type User } from "./users.js";

declare module "express-serve-static-core" {
  interface Request {
    currentUser?: User | null;
  }
}

/** Parse the Cookie header into a map. */
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

/** Populate req.currentUser / res.locals.currentUser from the session cookie. */
export function loadUser(req: Request, res: Response, next: NextFunction): void {
  const cookies = parseCookies(req.headers.cookie);
  const username = readSession(cookies[SESSION_COOKIE]);
  const user = username ? getUser(username) : null;
  req.currentUser = user;
  res.locals.currentUser = user;
  next();
}

/** Gate a web route behind login, redirecting to /login with a return path. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.currentUser) {
    next();
    return;
  }
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

/** Gate a web route behind admin rights (login first, then admin). */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.currentUser?.admin) {
    next();
    return;
  }
  if (!req.currentUser) {
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    return;
  }
  res.status(403).render("error", { message: "You must be an admin to view this page." });
}

/**
 * Validate HTTP Basic credentials (used by the git transport). Accepts either
 * an account password or a personal access token. The token may be supplied as
 * the password (any username) or as the username with an empty password, which
 * covers the common `https://<user>:<token>@…` and `https://<token>@…` forms.
 */
export function checkBasicAuth(header: string | undefined): User | null {
  if (!header || !header.startsWith("Basic ")) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return null;
  const username = decoded.slice(0, sep);
  const password = decoded.slice(sep + 1);

  const byPassword = authenticate(username, password);
  if (byPassword) return byPassword;

  // Fall back to token auth (token in either the password or username field).
  return findUserByToken(password) ?? findUserByToken(username);
}
