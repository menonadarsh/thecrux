import type { Request, Response } from "express";
import { getRepo, type RepoSummary } from "../git/repos.js";
import { canReadSummary } from "./access.js";

/**
 * Resolve the repository addressed by `:owner/:name` and enforce read access.
 *
 * Returns the repo if the current user may view it. Otherwise it responds with
 * 404 and returns null — private repos are *hidden* (not 403'd) from anyone who
 * can't read them, so their existence isn't leaked. Callers should `return`
 * immediately when this yields null.
 */
export async function loadReadableRepo(
  req: Request,
  res: Response,
): Promise<RepoSummary | null> {
  const slug = `${req.params.owner}/${req.params.name}`;
  const repo = await getRepo(slug);
  if (!repo || !canReadSummary(repo, req.currentUser?.username)) {
    res.status(404).render("404", { name: slug });
    return null;
  }
  return repo;
}
