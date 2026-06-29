import { Router, type Request } from "express";
import { requireAdmin } from "../auth/middleware.js";
import {
  createInvite,
  getRegistrationPolicy,
  isRegistrationPolicy,
  listInvites,
  revokeInvite,
  setRegistrationPolicy,
} from "../auth/instance.js";
import { adminCount, getUser, isAdmin, listUsers, setAdmin } from "../auth/users.js";

export const adminRouter = Router();

/** Absolute base URL of this instance, for building shareable invite links. */
function originOf(req: Request): string {
  return `${req.protocol}://${req.get("host")}`;
}

function renderPanel(req: Request, error: string | null = null, status = 200): void {
  const origin = originOf(req);
  req.res!.status(status).render("admin", {
    error,
    registration: getRegistrationPolicy(),
    invites: listInvites().map((i) => ({ ...i, url: `${origin}/register?invite=${i.token}` })),
    users: listUsers(),
    adminCount: adminCount(),
  });
}

adminRouter.get("/admin", requireAdmin, (req, res, next) => {
  try {
    renderPanel(req);
  } catch (err) {
    next(err);
  }
});

// Change the registration policy.
adminRouter.post("/admin/registration", requireAdmin, async (req, res, next) => {
  try {
    const policy = req.body.registration;
    if (!isRegistrationPolicy(policy)) return renderPanel(req, "Unknown registration policy.", 400);
    await setRegistrationPolicy(policy);
    res.redirect("/admin");
  } catch (err) {
    next(err);
  }
});

// Mint a new single-use invite.
adminRouter.post("/admin/invites", requireAdmin, async (req, res, next) => {
  try {
    await createInvite(req.currentUser!.username, String(req.body.note ?? ""));
    res.redirect("/admin");
  } catch (err) {
    next(err);
  }
});

// Revoke an invite.
adminRouter.post("/admin/invites/revoke", requireAdmin, async (req, res, next) => {
  try {
    await revokeInvite(String(req.body.token ?? ""));
    res.redirect("/admin");
  } catch (err) {
    next(err);
  }
});

// Grant admin rights to a user.
adminRouter.post("/admin/users/promote", requireAdmin, async (req, res, next) => {
  try {
    const username = String(req.body.username ?? "");
    if (!getUser(username)) return renderPanel(req, `No such user '${username}'.`, 400);
    await setAdmin(username, true);
    res.redirect("/admin");
  } catch (err) {
    next(err);
  }
});

// Revoke admin rights — never the last admin standing.
adminRouter.post("/admin/users/demote", requireAdmin, async (req, res, next) => {
  try {
    const username = String(req.body.username ?? "");
    if (!isAdmin(username)) return renderPanel(req, `'${username}' is not an admin.`, 400);
    if (adminCount() <= 1) {
      return renderPanel(req, "Can't remove the last admin — promote someone else first.", 400);
    }
    await setAdmin(username, false);
    res.redirect("/admin");
  } catch (err) {
    next(err);
  }
});
