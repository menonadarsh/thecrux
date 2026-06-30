import { Router, type Request } from "express";
import { record, recordReq } from "../audit.js";
import { getOrg } from "../auth/orgs.js";
import { isReservedNamespace } from "../git/exec.js";
import {
  consumeInvite,
  getRegistrationPolicy,
  inviteValid,
  type RegistrationPolicy,
} from "../auth/instance.js";
import { SESSION_COOKIE, SESSION_MAX_AGE_MS, createSession } from "../auth/session.js";
import { AuthError, authenticate, createUser, userCount } from "../auth/users.js";
import { config } from "../config.js";

export const authRouter = Router();

/**
 * Decide what registration mode applies to this request. The very first account
 * on a fresh instance ("bootstrap") is always allowed and becomes the admin,
 * regardless of policy.
 */
function registrationMode(): "bootstrap" | RegistrationPolicy {
  return userCount() === 0 ? "bootstrap" : getRegistrationPolicy();
}

/**
 * Session cookie options. The Secure flag is set when the request is HTTPS (or
 * forced via config), so plain-HTTP intranet deployments keep working while TLS
 * deployments get a Secure cookie.
 */
function cookieOpts(req: Request) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.forceSecureCookies || req.secure,
    maxAge: SESSION_MAX_AGE_MS,
    path: "/",
  };
}

/** Only allow relative paths as post-login redirects (avoid open redirects). */
function safeNext(next: unknown): string {
  const s = typeof next === "string" ? next : "";
  return s.startsWith("/") && !s.startsWith("//") ? s : "/";
}

authRouter.get("/login", (req, res) => {
  if (req.currentUser) {
    res.redirect("/");
    return;
  }
  res.render("login", { error: null, next: safeNext(req.query.next), values: { username: "" } });
});

authRouter.post("/login", (req, res) => {
  const username = String(req.body.username ?? "");
  const password = String(req.body.password ?? "");
  const next = safeNext(req.body.next);
  const user = authenticate(username, password);
  if (!user) {
    record({ action: "login.failure", actor: null, ip: req.ip, detail: `username: ${username}` });
    res.status(401).render("login", {
      error: "Invalid username or password.",
      next,
      values: { username },
    });
    return;
  }
  record({ action: "login.success", actor: user.username, ip: req.ip });
  res.cookie(SESSION_COOKIE, createSession(user.username), cookieOpts(req));
  res.redirect(next);
});

authRouter.get("/register", (req, res) => {
  if (req.currentUser) {
    res.redirect("/");
    return;
  }
  res.render("register", {
    error: null,
    mode: registrationMode(),
    next: safeNext(req.query.next),
    values: { username: "", displayName: "", invite: String(req.query.invite ?? "") },
  });
});

authRouter.post("/register", async (req, res, next) => {
  const username = String(req.body.username ?? "");
  const displayName = String(req.body.displayName ?? "");
  const password = String(req.body.password ?? "");
  const invite = String(req.body.invite ?? "").trim();
  const redirect = safeNext(req.body.next);
  const mode = registrationMode();

  const fail = (message: string, status = 400) =>
    void res.status(status).render("register", {
      error: message,
      mode,
      next: redirect,
      values: { username, displayName, invite },
    });

  // Enforce the registration policy (the bootstrap account bypasses it).
  if (mode === "closed") return fail("Registration is closed on this server.", 403);
  if (mode === "invite" && !inviteValid(invite)) {
    return fail("A valid invite is required to register on this server.", 403);
  }

  // The username shares a global namespace with orgs and route words.
  if (isReservedNamespace(username.trim())) return fail("That username is reserved.");
  if (getOrg(username.trim())) return fail(`The name '${username.trim()}' is taken.`);

  try {
    const user = await createUser(username, password, displayName);
    // Spend the invite only once the account actually exists.
    if (mode === "invite") await consumeInvite(invite);
    record({ action: "register", actor: user.username, ip: req.ip, detail: mode });
    res.cookie(SESSION_COOKIE, createSession(user.username), cookieOpts(req));
    res.redirect(redirect);
  } catch (err) {
    if (err instanceof AuthError) return fail(err.message);
    next(err);
  }
});

authRouter.post("/logout", (req, res) => {
  recordReq(req, "logout");
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.redirect("/");
});
