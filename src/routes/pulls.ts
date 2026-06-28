import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { compareRefs, mergeability, mergeRefs } from "../git/compare.js";
import { listRefNames } from "../git/refs.js";
import { getRepo, type RepoSummary } from "../git/repos.js";
import { renderMarkdown } from "../render/markdown.js";
import {
  countOpenPulls,
  createPull,
  getPull,
  listPulls,
  updatePull,
  type PullState,
} from "../pulls/store.js";

export const pullsRouter = Router();

const enc = encodeURIComponent;

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

async function loadRepo(name: string) {
  return getRepo(name);
}

// Pull request list.
pullsRouter.get("/:name/pulls", async (req, res, next) => {
  try {
    const repo = await loadRepo(req.params.name);
    if (!repo) {
      res.status(404).render("404", { name: req.params.name });
      return;
    }
    const filter = String(req.query.state ?? "open");
    const state: PullState | undefined =
      filter === "open" || filter === "merged" || filter === "closed" ? filter : undefined;
    const pulls = listPulls(repo.name, state);
    const counts = {
      open: listPulls(repo.name, "open").length,
      merged: listPulls(repo.name, "merged").length,
      closed: listPulls(repo.name, "closed").length,
    };
    const { branches, tags } = await listRefNames(repo.name);
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
pullsRouter.get("/:name/pulls/new", requireAuth, async (req, res, next) => {
  try {
    const repo = await loadRepo(req.params.name);
    if (!repo) {
      res.status(404).render("404", { name: req.params.name });
      return;
    }
    const { branches, tags } = await listRefNames(repo.name);
    const base = String(req.query.base ?? repo.defaultBranch ?? "main");
    const head = String(req.query.head ?? "");
    let comparison = null;
    let merge = null;
    if (head && head !== base) {
      comparison = await compareRefs(repo.name, base, head);
      if (comparison) merge = await mergeability(repo.name, comparison);
    }
    res.render("pull-new", {
      repo,
      branches,
      tags,
      base,
      head,
      comparison,
      merge,
      error: null,
      repobar: repobar(repo, branches.length, tags.length, countOpenPulls(repo.name)),
    });
  } catch (err) {
    next(err);
  }
});

// Create a pull request.
pullsRouter.post("/:name/pulls", requireAuth, async (req, res, next) => {
  try {
    const repo = await loadRepo(req.params.name);
    if (!repo) {
      res.status(404).render("404", { name: req.params.name });
      return;
    }
    const base = String(req.body.base ?? "");
    const head = String(req.body.head ?? "");
    const title = String(req.body.title ?? "");
    const body = String(req.body.body ?? "");
    const { branches, tags } = await listRefNames(repo.name);

    const renderError = async (error: string) => {
      const comparison = head && head !== base ? await compareRefs(repo.name, base, head) : null;
      const merge = comparison ? await mergeability(repo.name, comparison) : null;
      res.status(400).render("pull-new", {
        repo, branches, tags, base, head, comparison, merge, error,
        repobar: repobar(repo, branches.length, tags.length, countOpenPulls(repo.name)),
      });
    };

    if (!base || !head) return void (await renderError("Choose both a base and a compare ref."));
    if (base === head) return void (await renderError("Base and compare must differ."));
    const comparison = await compareRefs(repo.name, base, head);
    if (!comparison) return void (await renderError("One of the refs does not exist."));
    if (comparison.identical) {
      return void (await renderError(`'${head}' has no commits beyond '${base}'.`));
    }

    const pr = await createPull(repo.name, {
      title,
      body,
      author: req.currentUser!.username,
      base,
      head,
    });
    res.redirect(`/${enc(repo.name)}/pulls/${pr.id}`);
  } catch (err) {
    next(err);
  }
});

// Pull request detail.
pullsRouter.get("/:name/pulls/:id", async (req, res, next) => {
  try {
    const repo = await loadRepo(req.params.name);
    if (!repo) {
      res.status(404).render("404", { name: req.params.name });
      return;
    }
    const id = Number(req.params.id);
    const pr = Number.isInteger(id) ? getPull(repo.name, id) : null;
    if (!pr) {
      res.status(404).render("404", { name: `${repo.name}/pulls/${req.params.id}` });
      return;
    }
    const comparison = await compareRefs(repo.name, pr.base, pr.head);
    const merge = comparison ? await mergeability(repo.name, comparison) : null;
    const { branches, tags } = await listRefNames(repo.name);
    res.render("pull", {
      repo,
      pr,
      comparison,
      merge,
      markdownBody: pr.body ? renderMarkdown(pr.body) : "",
      repobar: repobar(repo, branches.length, tags.length, countOpenPulls(repo.name)),
    });
  } catch (err) {
    next(err);
  }
});

// Merge a pull request.
pullsRouter.post("/:name/pulls/:id/merge", requireAuth, async (req, res, next) => {
  try {
    const repo = await loadRepo(req.params.name);
    if (!repo) {
      res.status(404).render("404", { name: req.params.name });
      return;
    }
    const id = Number(req.params.id);
    const pr = Number.isInteger(id) ? getPull(repo.name, id) : null;
    if (!pr) {
      res.status(404).render("404", { name: `${repo.name}/pulls/${req.params.id}` });
      return;
    }
    if (pr.state !== "open") {
      res.redirect(`/${enc(repo.name)}/pulls/${pr.id}`);
      return;
    }
    const user = req.currentUser!;
    const message = `Merge pull request #${pr.id}: ${pr.title}`;
    const result = await mergeRefs(repo.name, pr.base, pr.head, message, {
      name: user.displayName || user.username,
      email: `${user.username}@thecrux.local`,
    });
    if (!result.ok) {
      const comparison = await compareRefs(repo.name, pr.base, pr.head);
      const merge = comparison ? await mergeability(repo.name, comparison) : null;
      const { branches, tags } = await listRefNames(repo.name);
      res.status(409).render("pull", {
        repo,
        pr,
        comparison,
        merge,
        markdownBody: pr.body ? renderMarkdown(pr.body) : "",
        mergeError: result.conflict
          ? "This pull request has conflicts and can't be merged automatically."
          : `Could not merge: ${result.reason ?? "unknown error"}.`,
        repobar: repobar(repo, branches.length, tags.length, countOpenPulls(repo.name)),
      });
      return;
    }
    await updatePull(repo.name, pr.id, {
      state: "merged",
      mergedAt: new Date().toISOString(),
      mergedBy: user.username,
      mergeCommit: result.sha,
      fastForward: result.fastForward,
    });
    res.redirect(`/${enc(repo.name)}/pulls/${pr.id}`);
  } catch (err) {
    next(err);
  }
});

// Close / reopen.
pullsRouter.post("/:name/pulls/:id/close", requireAuth, async (req, res, next) => {
  try {
    const repo = await loadRepo(req.params.name);
    if (!repo) return void res.status(404).render("404", { name: req.params.name });
    const id = Number(req.params.id);
    const pr = Number.isInteger(id) ? getPull(repo.name, id) : null;
    if (pr && pr.state === "open") {
      await updatePull(repo.name, id, { state: "closed", closedAt: new Date().toISOString() });
    }
    res.redirect(`/${enc(repo.name)}/pulls/${id}`);
  } catch (err) {
    next(err);
  }
});

pullsRouter.post("/:name/pulls/:id/reopen", requireAuth, async (req, res, next) => {
  try {
    const repo = await loadRepo(req.params.name);
    if (!repo) return void res.status(404).render("404", { name: req.params.name });
    const id = Number(req.params.id);
    const pr = Number.isInteger(id) ? getPull(repo.name, id) : null;
    if (pr && pr.state === "closed") {
      await updatePull(repo.name, id, { state: "open", closedAt: undefined });
    }
    res.redirect(`/${enc(repo.name)}/pulls/${id}`);
  } catch (err) {
    next(err);
  }
});
