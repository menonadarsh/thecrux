import { Router, type Request } from "express";
import { requireAuth } from "../auth/middleware.js";
import { compareRefs, mergeability, mergeRefs } from "../git/compare.js";
import { listRefNames } from "../git/refs.js";
import { getRepo, type RepoSummary } from "../git/repos.js";
import { renderMarkdown } from "../render/markdown.js";
import type { Comment } from "../issues/store.js";
import {
  addPullComment,
  countOpenPulls,
  createPull,
  getPull,
  listPulls,
  updatePull,
  type PullState,
} from "../pulls/store.js";

export const pullsRouter = Router();

const enc = encodeURIComponent;
const base = (repo: RepoSummary) => `/${enc(repo.owner)}/${enc(repo.name)}`;
const slugOf = (req: Request) => `${req.params.owner}/${req.params.name}`;

/** Build the repo subnav data for pull-request pages. */
function repobar(repo: RepoSummary, branchCount: number, tagCount: number, pullCount: number) {
  return {
    repo,
    ref: repo.defaultBranch ?? "main",
    active: "pulls" as const,
    branchCount,
    tagCount,
    pullCount,
  };
}

/** Render comment markdown for display. */
function renderComments(comments: Comment[] | undefined) {
  return (comments ?? []).map((c) => ({ ...c, html: c.body ? renderMarkdown(c.body) : "" }));
}

// Pull request list.
pullsRouter.get("/:owner/:name/pulls", async (req, res, next) => {
  try {
    const repo = await getRepo(slugOf(req));
    if (!repo) return void res.status(404).render("404", { name: slugOf(req) });
    const filter = String(req.query.state ?? "open");
    const state: PullState | undefined =
      filter === "open" || filter === "merged" || filter === "closed" ? filter : undefined;
    const pulls = listPulls(repo.slug, state);
    const counts = {
      open: listPulls(repo.slug, "open").length,
      merged: listPulls(repo.slug, "merged").length,
      closed: listPulls(repo.slug, "closed").length,
    };
    const { branches, tags } = await listRefNames(repo.slug);
    res.render("pulls", {
      repo,
      pulls,
      filter,
      counts,
      repobar: repobar(repo, branches.length, tags.length, counts.open),
    });
  } catch (err) {
    next(err);
  }
});

// New pull request (compare) form.
pullsRouter.get("/:owner/:name/pulls/new", requireAuth, async (req, res, next) => {
  try {
    const repo = await getRepo(slugOf(req));
    if (!repo) return void res.status(404).render("404", { name: slugOf(req) });
    const { branches, tags } = await listRefNames(repo.slug);
    const baseRef = String(req.query.base ?? repo.defaultBranch ?? "main");
    const head = String(req.query.head ?? "");
    let comparison = null;
    let merge = null;
    if (head && head !== baseRef) {
      comparison = await compareRefs(repo.slug, baseRef, head);
      if (comparison) merge = await mergeability(repo.slug, comparison);
    }
    res.render("pull-new", {
      repo,
      branches,
      tags,
      base: baseRef,
      head,
      comparison,
      merge,
      error: null,
      repobar: repobar(repo, branches.length, tags.length, countOpenPulls(repo.slug)),
    });
  } catch (err) {
    next(err);
  }
});

// Create a pull request.
pullsRouter.post("/:owner/:name/pulls", requireAuth, async (req, res, next) => {
  try {
    const repo = await getRepo(slugOf(req));
    if (!repo) return void res.status(404).render("404", { name: slugOf(req) });
    const baseRef = String(req.body.base ?? "");
    const head = String(req.body.head ?? "");
    const title = String(req.body.title ?? "");
    const body = String(req.body.body ?? "");
    const { branches, tags } = await listRefNames(repo.slug);

    const renderError = async (error: string) => {
      const comparison = head && head !== baseRef ? await compareRefs(repo.slug, baseRef, head) : null;
      const merge = comparison ? await mergeability(repo.slug, comparison) : null;
      res.status(400).render("pull-new", {
        repo, branches, tags, base: baseRef, head, comparison, merge, error,
        repobar: repobar(repo, branches.length, tags.length, countOpenPulls(repo.slug)),
      });
    };

    if (!baseRef || !head) return void (await renderError("Choose both a base and a compare ref."));
    if (baseRef === head) return void (await renderError("Base and compare must differ."));
    const comparison = await compareRefs(repo.slug, baseRef, head);
    if (!comparison) return void (await renderError("One of the refs does not exist."));
    if (comparison.identical) {
      return void (await renderError(`'${head}' has no commits beyond '${baseRef}'.`));
    }

    const pr = await createPull(repo.slug, {
      title,
      body,
      author: req.currentUser!.username,
      base: baseRef,
      head,
    });
    res.redirect(`${base(repo)}/pulls/${pr.id}`);
  } catch (err) {
    next(err);
  }
});

// Pull request detail.
pullsRouter.get("/:owner/:name/pulls/:id", async (req, res, next) => {
  try {
    const repo = await getRepo(slugOf(req));
    if (!repo) return void res.status(404).render("404", { name: slugOf(req) });
    const id = Number(req.params.id);
    const pr = Number.isInteger(id) ? getPull(repo.slug, id) : null;
    if (!pr) {
      res.status(404).render("404", { name: `${repo.slug}/pulls/${req.params.id}` });
      return;
    }
    const comparison = await compareRefs(repo.slug, pr.base, pr.head);
    const merge = comparison ? await mergeability(repo.slug, comparison) : null;
    const { branches, tags } = await listRefNames(repo.slug);
    res.render("pull", {
      repo,
      pr,
      comparison,
      merge,
      markdownBody: pr.body ? renderMarkdown(pr.body) : "",
      comments: renderComments(pr.comments),
      repobar: repobar(repo, branches.length, tags.length, countOpenPulls(repo.slug)),
    });
  } catch (err) {
    next(err);
  }
});

// Add a comment to a pull request.
pullsRouter.post("/:owner/:name/pulls/:id/comment", requireAuth, async (req, res, next) => {
  try {
    const repo = await getRepo(slugOf(req));
    if (!repo) return void res.status(404).render("404", { name: slugOf(req) });
    const id = Number(req.params.id);
    const body = String(req.body.body ?? "");
    if (body.trim()) await addPullComment(repo.slug, id, req.currentUser!.username, body);
    res.redirect(`${base(repo)}/pulls/${id}#bottom`);
  } catch (err) {
    next(err);
  }
});

// Merge a pull request.
pullsRouter.post("/:owner/:name/pulls/:id/merge", requireAuth, async (req, res, next) => {
  try {
    const repo = await getRepo(slugOf(req));
    if (!repo) return void res.status(404).render("404", { name: slugOf(req) });
    const id = Number(req.params.id);
    const pr = Number.isInteger(id) ? getPull(repo.slug, id) : null;
    if (!pr) {
      res.status(404).render("404", { name: `${repo.slug}/pulls/${req.params.id}` });
      return;
    }
    if (pr.state !== "open") {
      res.redirect(`${base(repo)}/pulls/${pr.id}`);
      return;
    }
    const user = req.currentUser!;
    const message = `Merge pull request #${pr.id}: ${pr.title}`;
    const result = await mergeRefs(repo.slug, pr.base, pr.head, message, {
      name: user.displayName || user.username,
      email: `${user.username}@thecrux.local`,
    });
    if (!result.ok) {
      const comparison = await compareRefs(repo.slug, pr.base, pr.head);
      const merge = comparison ? await mergeability(repo.slug, comparison) : null;
      const { branches, tags } = await listRefNames(repo.slug);
      res.status(409).render("pull", {
        repo,
        pr,
        comparison,
        merge,
        markdownBody: pr.body ? renderMarkdown(pr.body) : "",
        comments: renderComments(pr.comments),
        mergeError: result.conflict
          ? "This pull request has conflicts and can't be merged automatically."
          : `Could not merge: ${result.reason ?? "unknown error"}.`,
        repobar: repobar(repo, branches.length, tags.length, countOpenPulls(repo.slug)),
      });
      return;
    }
    await updatePull(repo.slug, pr.id, {
      state: "merged",
      mergedAt: new Date().toISOString(),
      mergedBy: user.username,
      mergeCommit: result.sha,
      fastForward: result.fastForward,
    });
    res.redirect(`${base(repo)}/pulls/${pr.id}`);
  } catch (err) {
    next(err);
  }
});

// Close / reopen.
pullsRouter.post("/:owner/:name/pulls/:id/close", requireAuth, async (req, res, next) => {
  try {
    const repo = await getRepo(slugOf(req));
    if (!repo) return void res.status(404).render("404", { name: slugOf(req) });
    const id = Number(req.params.id);
    const pr = Number.isInteger(id) ? getPull(repo.slug, id) : null;
    if (pr && pr.state === "open") {
      await updatePull(repo.slug, id, { state: "closed", closedAt: new Date().toISOString() });
    }
    res.redirect(`${base(repo)}/pulls/${id}`);
  } catch (err) {
    next(err);
  }
});

pullsRouter.post("/:owner/:name/pulls/:id/reopen", requireAuth, async (req, res, next) => {
  try {
    const repo = await getRepo(slugOf(req));
    if (!repo) return void res.status(404).render("404", { name: slugOf(req) });
    const id = Number(req.params.id);
    const pr = Number.isInteger(id) ? getPull(repo.slug, id) : null;
    if (pr && pr.state === "closed") {
      await updatePull(repo.slug, id, { state: "open", closedAt: undefined });
    }
    res.redirect(`${base(repo)}/pulls/${id}`);
  } catch (err) {
    next(err);
  }
});
