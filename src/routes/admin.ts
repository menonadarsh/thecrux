import { Router, type Request } from "express";
import { readRecent, recordReq } from "../audit.js";
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

const AUDIT_PAGE_SIZE = 100;

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
    recordReq(req, "registration.policy", { detail: policy });
    res.redirect("/admin");
  } catch (err) {
    next(err);
  }
});

// Mint a new single-use invite.
adminRouter.post("/admin/invites", requireAdmin, async (req, res, next) => {
  try {
    await createInvite(req.currentUser!.username, String(req.body.note ?? ""));
    recordReq(req, "invite.create");
    res.redirect("/admin");
  } catch (err) {
    next(err);
  }
});

// Revoke an invite.
adminRouter.post("/admin/invites/revoke", requireAdmin, async (req, res, next) => {
  try {
    await revokeInvite(String(req.body.token ?? ""));
    recordReq(req, "invite.revoke");
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
    recordReq(req, "user.promote", { target: username });
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
    recordReq(req, "user.demote", { target: username });
    res.redirect("/admin");
  } catch (err) {
    next(err);
  }
});

// Audit log — security-relevant events, newest first.
adminRouter.get("/admin/audit", requireAdmin, async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const actor = String(req.query.actor ?? "").trim() || undefined;
    const action = String(req.query.action ?? "").trim() || undefined;
    const { events, total } = await readRecent({
      limit: AUDIT_PAGE_SIZE,
      offset: (page - 1) * AUDIT_PAGE_SIZE,
      actor,
      action,
    });
    res.render("audit", {
      events,
      total,
      page,
      pageSize: AUDIT_PAGE_SIZE,
      filter: { actor: actor ?? "", action: action ?? "" },
    });
  } catch (err) {
    next(err);
  }
});
