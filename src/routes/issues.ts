import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { listRefNames } from "../git/refs.js";
import { getRepo, type RepoSummary } from "../git/repos.js";
import {
  addIssueComment,
  countOpenIssues,
  createIssue,
  getIssue,
  listIssues,
  updateIssue,
  type Comment,
  type IssueState,
} from "../issues/store.js";
import { renderMarkdown } from "../render/markdown.js";

export const issuesRouter = Router();

const enc = encodeURIComponent;

function repobar(repo: RepoSummary, branchCount: number, tagCount: number, issueCount: number) {
  return {
    repo,
    ref: repo.defaultBranch ?? "main",
    active: "issues" as const,
    branchCount,
    tagCount,
    issueCount,
  };
}

/** Render a comment's markdown for display. */
function renderComments(comments: Comment[]) {
  return comments.map((c) => ({ ...c, html: c.body ? renderMarkdown(c.body) : "" }));
}

// Issue list.
issuesRouter.get("/:name/issues", async (req, res, next) => {
  try {
    const repo = await getRepo(req.params.name);
    if (!repo) return void res.status(404).render("404", { name: req.params.name });
    const filter = String(req.query.state ?? "open");
    const state: IssueState | undefined =
      filter === "open" || filter === "closed" ? filter : undefined;
    const issues = listIssues(repo.name, state);
    const counts = {
      open: listIssues(repo.name, "open").length,
      closed: listIssues(repo.name, "closed").length,
    };
    const { branches, tags } = await listRefNames(repo.name);
    res.render("issues", {
      repo,
      issues,
      filter,
      counts,
      repobar: repobar(repo, branches.length, tags.length, counts.open),
    });
  } catch (err) {
    next(err);
  }
});

// New issue form.
issuesRouter.get("/:name/issues/new", requireAuth, async (req, res, next) => {
  try {
    const repo = await getRepo(req.params.name);
    if (!repo) return void res.status(404).render("404", { name: req.params.name });
    const { branches, tags } = await listRefNames(repo.name);
    res.render("issue-new", {
      repo,
      error: null,
      values: { title: "", body: "" },
      repobar: repobar(repo, branches.length, tags.length, countOpenIssues(repo.name)),
    });
  } catch (err) {
    next(err);
  }
});

// Create an issue.
issuesRouter.post("/:name/issues", requireAuth, async (req, res, next) => {
  try {
    const repo = await getRepo(req.params.name);
    if (!repo) return void res.status(404).render("404", { name: req.params.name });
    const title = String(req.body.title ?? "");
    const body = String(req.body.body ?? "");
    if (!title.trim()) {
      const { branches, tags } = await listRefNames(repo.name);
      res.status(400).render("issue-new", {
        repo,
        error: "An issue needs a title.",
        values: { title, body },
        repobar: repobar(repo, branches.length, tags.length, countOpenIssues(repo.name)),
      });
      return;
    }
    const issue = await createIssue(repo.name, { title, body, author: req.currentUser!.username });
    res.redirect(`/${enc(repo.name)}/issues/${issue.id}`);
  } catch (err) {
    next(err);
  }
});

// Issue detail.
issuesRouter.get("/:name/issues/:id", async (req, res, next) => {
  try {
    const repo = await getRepo(req.params.name);
    if (!repo) return void res.status(404).render("404", { name: req.params.name });
    const id = Number(req.params.id);
    const issue = Number.isInteger(id) ? getIssue(repo.name, id) : null;
    if (!issue) {
      res.status(404).render("404", { name: `${repo.name}/issues/${req.params.id}` });
      return;
    }
    const { branches, tags } = await listRefNames(repo.name);
    res.render("issue", {
      repo,
      issue,
      bodyHtml: issue.body ? renderMarkdown(issue.body) : "",
      comments: renderComments(issue.comments),
      repobar: repobar(repo, branches.length, tags.length, countOpenIssues(repo.name)),
    });
  } catch (err) {
    next(err);
  }
});

// Add a comment.
issuesRouter.post("/:name/issues/:id/comment", requireAuth, async (req, res, next) => {
  try {
    const repo = await getRepo(req.params.name);
    if (!repo) return void res.status(404).render("404", { name: req.params.name });
    const id = Number(req.params.id);
    const body = String(req.body.body ?? "");
    if (body.trim()) {
      await addIssueComment(repo.name, id, req.currentUser!.username, body);
    }
    res.redirect(`/${enc(repo.name)}/issues/${id}#bottom`);
  } catch (err) {
    next(err);
  }
});

// Close / reopen.
issuesRouter.post("/:name/issues/:id/close", requireAuth, async (req, res, next) => {
  try {
    const repo = await getRepo(req.params.name);
    if (!repo) return void res.status(404).render("404", { name: req.params.name });
    const id = Number(req.params.id);
    const issue = Number.isInteger(id) ? getIssue(repo.name, id) : null;
    if (issue && issue.state === "open") {
      // A comment may accompany the close action.
      const body = String(req.body.body ?? "");
      if (body.trim()) await addIssueComment(repo.name, id, req.currentUser!.username, body);
      await updateIssue(repo.name, id, {
        state: "closed",
        closedAt: new Date().toISOString(),
        closedBy: req.currentUser!.username,
      });
    }
    res.redirect(`/${enc(repo.name)}/issues/${id}#bottom`);
  } catch (err) {
    next(err);
  }
});

issuesRouter.post("/:name/issues/:id/reopen", requireAuth, async (req, res, next) => {
  try {
    const repo = await getRepo(req.params.name);
    if (!repo) return void res.status(404).render("404", { name: req.params.name });
    const id = Number(req.params.id);
    const issue = Number.isInteger(id) ? getIssue(repo.name, id) : null;
    if (issue && issue.state === "closed") {
      await updateIssue(repo.name, id, { state: "open", closedAt: undefined, closedBy: undefined });
    }
    res.redirect(`/${enc(repo.name)}/issues/${id}#bottom`);
  } catch (err) {
    next(err);
  }
});
