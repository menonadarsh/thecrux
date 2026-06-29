import { Router, type Request } from "express";
import { canWrite } from "../auth/access.js";
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
const base = (repo: RepoSummary) => `/${enc(repo.owner)}/${enc(repo.name)}`;
const slugOf = (req: Request) => `${req.params.owner}/${req.params.name}`;

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
issuesRouter.get("/:owner/:name/issues", async (req, res, next) => {
  try {
    const repo = await getRepo(slugOf(req));
    if (!repo) return void res.status(404).render("404", { name: slugOf(req) });
    const filter = String(req.query.state ?? "open");
    const state: IssueState | undefined =
      filter === "open" || filter === "closed" ? filter : undefined;
    const issues = listIssues(repo.slug, state);
    const counts = {
      open: listIssues(repo.slug, "open").length,
      closed: listIssues(repo.slug, "closed").length,
    };
    const { branches, tags } = await listRefNames(repo.slug);
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
issuesRouter.get("/:owner/:name/issues/new", requireAuth, async (req, res, next) => {
  try {
    const repo = await getRepo(slugOf(req));
    if (!repo) return void res.status(404).render("404", { name: slugOf(req) });
    const { branches, tags } = await listRefNames(repo.slug);
    res.render("issue-new", {
      repo,
      error: null,
      values: { title: "", body: "" },
      repobar: repobar(repo, branches.length, tags.length, countOpenIssues(repo.slug)),
    });
  } catch (err) {
    next(err);
  }
});

// Create an issue.
issuesRouter.post("/:owner/:name/issues", requireAuth, async (req, res, next) => {
  try {
    const repo = await getRepo(slugOf(req));
    if (!repo) return void res.status(404).render("404", { name: slugOf(req) });
    const title = String(req.body.title ?? "");
    const body = String(req.body.body ?? "");
    if (!title.trim()) {
      const { branches, tags } = await listRefNames(repo.slug);
      res.status(400).render("issue-new", {
        repo,
        error: "An issue needs a title.",
        values: { title, body },
        repobar: repobar(repo, branches.length, tags.length, countOpenIssues(repo.slug)),
      });
      return;
    }
    const issue = await createIssue(repo.slug, { title, body, author: req.currentUser!.username });
    res.redirect(`${base(repo)}/issues/${issue.id}`);
  } catch (err) {
    next(err);
  }
});

// Issue detail.
issuesRouter.get("/:owner/:name/issues/:id", async (req, res, next) => {
  try {
    const repo = await getRepo(slugOf(req));
    if (!repo) return void res.status(404).render("404", { name: slugOf(req) });
    const id = Number(req.params.id);
    const issue = Number.isInteger(id) ? getIssue(repo.slug, id) : null;
    if (!issue) {
      res.status(404).render("404", { name: `${repo.slug}/issues/${req.params.id}` });
      return;
    }
    const { branches, tags } = await listRefNames(repo.slug);
    res.render("issue", {
      repo,
      issue,
      bodyHtml: issue.body ? renderMarkdown(issue.body) : "",
      comments: renderComments(issue.comments),
      canWrite: canWrite(repo.slug, req.currentUser?.username),
      repobar: repobar(repo, branches.length, tags.length, countOpenIssues(repo.slug)),
    });
  } catch (err) {
    next(err);
  }
});

// Add a comment.
issuesRouter.post("/:owner/:name/issues/:id/comment", requireAuth, async (req, res, next) => {
  try {
    const repo = await getRepo(slugOf(req));
    if (!repo) return void res.status(404).render("404", { name: slugOf(req) });
    const id = Number(req.params.id);
    const body = String(req.body.body ?? "");
    if (body.trim()) {
      await addIssueComment(repo.slug, id, req.currentUser!.username, body);
    }
    res.redirect(`${base(repo)}/issues/${id}#bottom`);
  } catch (err) {
    next(err);
  }
});

// Close / reopen.
issuesRouter.post("/:owner/:name/issues/:id/close", requireAuth, async (req, res, next) => {
  try {
    const repo = await getRepo(slugOf(req));
    if (!repo) return void res.status(404).render("404", { name: slugOf(req) });
    const id = Number(req.params.id);
    const issue = Number.isInteger(id) ? getIssue(repo.slug, id) : null;
    const user = req.currentUser!.username;
    if (issue && issue.state === "open" && (canWrite(repo.slug, user) || issue.author === user)) {
      const body = String(req.body.body ?? "");
      if (body.trim()) await addIssueComment(repo.slug, id, user, body);
      await updateIssue(repo.slug, id, {
        state: "closed",
        closedAt: new Date().toISOString(),
        closedBy: user,
      });
    }
    res.redirect(`${base(repo)}/issues/${id}#bottom`);
  } catch (err) {
    next(err);
  }
});

issuesRouter.post("/:owner/:name/issues/:id/reopen", requireAuth, async (req, res, next) => {
  try {
    const repo = await getRepo(slugOf(req));
    if (!repo) return void res.status(404).render("404", { name: slugOf(req) });
    const id = Number(req.params.id);
    const issue = Number.isInteger(id) ? getIssue(repo.slug, id) : null;
    const user = req.currentUser!.username;
    if (issue && issue.state === "closed" && (canWrite(repo.slug, user) || issue.author === user)) {
      await updateIssue(repo.slug, id, { state: "open", closedAt: undefined, closedBy: undefined });
    }
    res.redirect(`${base(repo)}/issues/${id}#bottom`);
  } catch (err) {
    next(err);
  }
});
