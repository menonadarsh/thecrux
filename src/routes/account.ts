import { Router, type Request, type Response } from "express";
import { requireAuth } from "../auth/middleware.js";
import { SESSION_COOKIE } from "../auth/session.js";
import {
  AuthError,
  addSshKey,
  adminCount,
  changePassword,
  createToken,
  deleteUser,
  listSshKeys,
  listTokens,
  removeSshKey,
  revokeToken,
  setDisplayName,
} from "../auth/users.js";
import { deleteOwnerRepos, listReposByOwner } from "../git/repos.js";

export const accountRouter = Router();

interface AccountView {
  error?: string | null;
  notice?: string | null;
  /** Set once, immediately after creation, to show the plaintext secret. */
  newToken?: { name: string; secret: string } | null;
}

const SAVED_NOTICES: Record<string, string> = {
  profile: "Profile updated.",
  password: "Password changed.",
  sshkey: "SSH key added.",
};

async function renderAccount(
  req: Request,
  res: Response,
  view: AccountView = {},
  status = 200,
): Promise<void> {
  const username = req.currentUser!.username;
  const repos = await listReposByOwner(username);
  res.status(status).render("account", {
    tokens: listTokens(username),
    sshKeys: listSshKeys(username),
    repoCount: repos.length,
    error: view.error ?? null,
    notice: view.notice ?? null,
    newToken: view.newToken ?? null,
  });
}

accountRouter.get("/settings", requireAuth, async (req, res, next) => {
  try {
    const notice = SAVED_NOTICES[String(req.query.saved ?? "")] ?? null;
    await renderAccount(req, res, { notice });
  } catch (err) {
    next(err);
  }
});

// Update profile (display name).
accountRouter.post("/settings/profile", requireAuth, async (req, res, next) => {
  try {
    await setDisplayName(req.currentUser!.username, String(req.body.displayName ?? ""));
    res.redirect("/settings?saved=profile");
  } catch (err) {
    if (err instanceof AuthError) return void (await renderAccount(req, res, { error: err.message }, 400));
    next(err);
  }
});

// Change password (requires the current password).
accountRouter.post("/settings/password", requireAuth, async (req, res, next) => {
  try {
    await changePassword(
      req.currentUser!.username,
      String(req.body.currentPassword ?? ""),
      String(req.body.newPassword ?? ""),
    );
    res.redirect("/settings?saved=password");
  } catch (err) {
    if (err instanceof AuthError) return void (await renderAccount(req, res, { error: err.message }, 400));
    next(err);
  }
});

// Create a personal access token; the plaintext is shown once on the next view.
accountRouter.post("/settings/tokens", requireAuth, async (req, res, next) => {
  try {
    const name = String(req.body.name ?? "");
    const { secret } = await createToken(req.currentUser!.username, name);
    await renderAccount(req, res, { newToken: { name: name.trim(), secret } });
  } catch (err) {
    if (err instanceof AuthError) return void (await renderAccount(req, res, { error: err.message }, 400));
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

// Add an SSH public key.
accountRouter.post("/settings/ssh-keys", requireAuth, async (req, res, next) => {
  try {
    await addSshKey(
      req.currentUser!.username,
      String(req.body.publicKey ?? ""),
      String(req.body.name ?? ""),
    );
    res.redirect("/settings?saved=sshkey");
  } catch (err) {
    if (err instanceof AuthError) return void (await renderAccount(req, res, { error: err.message }, 400));
    next(err);
  }
});

// Remove an SSH public key by id.
accountRouter.post("/settings/ssh-keys/remove", requireAuth, async (req, res, next) => {
  try {
    await removeSshKey(req.currentUser!.username, String(req.body.id ?? ""));
    res.redirect("/settings");
  } catch (err) {
    next(err);
  }
});

// Permanently delete the account (and all of its repositories).
accountRouter.post("/settings/delete", requireAuth, async (req, res, next) => {
  try {
    const user = req.currentUser!;
    // Require typing the exact username to confirm.
    if (String(req.body.confirm ?? "").trim() !== user.username) {
      return void (await renderAccount(
        req,
        res,
        { error: "Type your username exactly to confirm deletion." },
        400,
      ));
    }
    // Don't strand the instance without an admin.
    if (user.admin && adminCount() <= 1) {
      return void (await renderAccount(
        req,
        res,
        { error: "Promote another admin before deleting the only admin account." },
        400,
      ));
    }
    await deleteOwnerRepos(user.username);
    await deleteUser(user.username);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.redirect("/");
  } catch (err) {
    next(err);
  }
});
