import { Router, type Request, type Response } from "express";
import { requireAuth } from "../auth/middleware.js";
import { AuthError, createToken, listTokens, revokeToken } from "../auth/users.js";

export const accountRouter = Router();

interface AccountView {
  error?: string | null;
  /** Set once, immediately after creation, to show the plaintext secret. */
  newToken?: { name: string; secret: string } | null;
}

function renderAccount(req: Request, res: Response, view: AccountView = {}, status = 200): void {
  res.status(status).render("account", {
    tokens: listTokens(req.currentUser!.username),
    error: view.error ?? null,
    newToken: view.newToken ?? null,
  });
}

accountRouter.get("/settings", requireAuth, (req, res, next) => {
  try {
    renderAccount(req, res);
  } catch (err) {
    next(err);
  }
});

// Create a personal access token; the plaintext is shown once on the next view.
accountRouter.post("/settings/tokens", requireAuth, async (req, res, next) => {
  try {
    const name = String(req.body.name ?? "");
    const { secret } = await createToken(req.currentUser!.username, name);
    renderAccount(req, res, { newToken: { name: name.trim(), secret } });
  } catch (err) {
    if (err instanceof AuthError) return renderAccount(req, res, { error: err.message }, 400);
    next(err);
  }
});

// Revoke a personal access token by id.
accountRouter.post("/settings/tokens/revoke", requireAuth, async (req, res, next) => {
  try {
    await revokeToken(req.currentUser!.username, String(req.body.id ?? ""));
    res.redirect("/settings");
  } catch (err) {
    next(err);
  }
});
