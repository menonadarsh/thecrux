import { Router } from "express";
import { SESSION_COOKIE, SESSION_MAX_AGE_MS, createSession } from "../auth/session.js";
import { AuthError, authenticate, createUser } from "../auth/users.js";

export const authRouter = Router();

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  maxAge: SESSION_MAX_AGE_MS,
  path: "/",
};

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
    res.status(401).render("login", {
      error: "Invalid username or password.",
      next,
      values: { username },
    });
    return;
  }
  res.cookie(SESSION_COOKIE, createSession(user.username), COOKIE_OPTS);
  res.redirect(next);
});

authRouter.get("/register", (req, res) => {
  if (req.currentUser) {
    res.redirect("/");
    return;
  }
  res.render("register", {
    error: null,
    next: safeNext(req.query.next),
    values: { username: "", displayName: "" },
  });
});

authRouter.post("/register", async (req, res, next) => {
  const username = String(req.body.username ?? "");
  const displayName = String(req.body.displayName ?? "");
  const password = String(req.body.password ?? "");
  const redirect = safeNext(req.body.next);
  try {
    const user = await createUser(username, password, displayName);
    res.cookie(SESSION_COOKIE, createSession(user.username), COOKIE_OPTS);
    res.redirect(redirect);
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(400).render("register", {
        error: err.message,
        next: redirect,
        values: { username, displayName },
      });
      return;
    }
    next(err);
  }
});

authRouter.post("/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.redirect("/");
});
