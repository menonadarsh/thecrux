import { Router, type Request, type Response } from "express";
import { recordReq } from "../audit.js";
import { requireAuth } from "../auth/middleware.js";
import {
  createOrg,
  deleteOrg,
  getOrg,
  isOrgOwner,
  removeMember,
  setMember,
  type OrgRole,
} from "../auth/orgs.js";
import { AuthError, getUser } from "../auth/users.js";
import { listReposByOwner } from "../git/repos.js";

export const orgsRouter = Router();

/** Resolve :name to an org the current user owns, or respond and return null. */
function requireOrgOwner(req: Request, res: Response): ReturnType<typeof getOrg> {
  const org = getOrg(String(req.params.name));
  if (!org) {
    res.status(404).render("404", { name: `orgs/${req.params.name}` });
    return null;
  }
  if (!isOrgOwner(org.name, req.currentUser?.username)) {
    res.status(403).render("error", { message: "Only an org owner can manage this organization." });
    return null;
  }
  return org;
}

async function renderSettings(res: Response, org: NonNullable<ReturnType<typeof getOrg>>, error: string | null = null, status = 200) {
  const members = Object.entries(org.members).map(([username, role]) => ({
    username,
    role,
    displayName: getUser(username)?.displayName ?? username,
  }));
  res.status(status).render("org-settings", { org, members, error });
}

orgsRouter.get("/orgs/new", requireAuth, (_req, res) => {
  res.render("org-new", { error: null, values: { name: "" } });
});

orgsRouter.post("/orgs/new", requireAuth, async (req, res, next) => {
  const name = String(req.body.name ?? "");
  try {
    const org = await createOrg(name, req.currentUser!.username);
    recordReq(req, "org.create", { target: org.name });
    res.redirect(`/${encodeURIComponent(org.name)}`);
  } catch (err) {
    if (err instanceof AuthError) {
      return res.status(400).render("org-new", { error: err.message, values: { name } });
    }
    next(err);
  }
});

orgsRouter.get("/orgs/:name/settings", requireAuth, async (req, res, next) => {
  try {
    const org = requireOrgOwner(req, res);
    if (!org) return;
    await renderSettings(res, org);
  } catch (err) {
    next(err);
  }
});

// Add or update a member's role.
orgsRouter.post("/orgs/:name/members", requireAuth, async (req, res, next) => {
  try {
    const org = requireOrgOwner(req, res);
    if (!org) return;
    const username = String(req.body.username ?? "").trim();
    const role: OrgRole = req.body.role === "owner" ? "owner" : "member";
    await setMember(org.name, username, role);
    recordReq(req, "org.member.add", { target: org.name, detail: `${getUser(username)!.username}:${role}` });
    res.redirect(`/orgs/${encodeURIComponent(org.name)}/settings`);
  } catch (err) {
    if (err instanceof AuthError) {
      const org = getOrg(String(req.params.name));
      if (org) return void (await renderSettings(res, org, err.message, 400));
    }
    next(err);
  }
});

// Remove a member.
orgsRouter.post("/orgs/:name/members/remove", requireAuth, async (req, res, next) => {
  try {
    const org = requireOrgOwner(req, res);
    if (!org) return;
    const username = String(req.body.username ?? "").trim();
    await removeMember(org.name, username);
    recordReq(req, "org.member.remove", { target: org.name, detail: username });
    res.redirect(`/orgs/${encodeURIComponent(org.name)}/settings`);
  } catch (err) {
    if (err instanceof AuthError) {
      const org = getOrg(String(req.params.name));
      if (org) return void (await renderSettings(res, org, err.message, 400));
    }
    next(err);
  }
});

// Delete the org (only when it owns no repositories).
orgsRouter.post("/orgs/:name/delete", requireAuth, async (req, res, next) => {
  try {
    const org = requireOrgOwner(req, res);
    if (!org) return;
    const repos = await listReposByOwner(org.name);
    if (repos.length > 0) {
      return void (await renderSettings(res, org, "Delete or transfer the org's repositories first.", 400));
    }
    await deleteOrg(org.name);
    recordReq(req, "org.delete", { target: org.name });
    res.redirect("/");
  } catch (err) {
    next(err);
  }
});
