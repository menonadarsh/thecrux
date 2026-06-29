import { Router, type Request, type Response } from "express";
import { requireAuth } from "../auth/middleware.js";
import { getCommit, listCommits } from "../git/history.js";
import { listBranches, listRefNames, listTags } from "../git/refs.js";
import {
  createRepo,
  getRepo,
  listRepos,
  listReposByOwner,
  RepoError,
  type RepoSummary,
} from "../git/repos.js";
import {
  cleanSubpath,
  findReadme,
  headCommit,
  listDirectory,
  objectType,
  readBlob,
} from "../git/tree.js";
import { isValidOwner } from "../git/exec.js";
import { getUser } from "../auth/users.js";
import { highlightFile } from "../render/highlight.js";
import { isMarkdown, renderMarkdown } from "../render/markdown.js";

export const reposRouter = Router();

const enc = encodeURIComponent;

/** Base URL path for a repo, e.g. "/ada/my-project". */
function base(repo: RepoSummary): string {
  return `/${enc(repo.owner)}/${enc(repo.name)}`;
}

/** The "owner/name" slug for the git layer from request params. */
function slugOf(req: Request): string {
  return `${req.params.owner}/${req.params.name}`;
}

/** Encode a slash-separated path, preserving the separators. */
function encPath(p: string): string {
  return cleanSubpath(p).split("/").filter(Boolean).map(enc).join("/");
}

interface Crumb {
  label: string;
  href: string | null;
}

/** Build breadcrumb segments for a path within a repo at a ref. */
function breadcrumb(repo: RepoSummary, ref: string, subpath: string, leafIsBlob: boolean): Crumb[] {
  const b = base(repo);
  const parts = cleanSubpath(subpath).split("/").filter(Boolean);
  const crumbs: Crumb[] = [
    { label: repo.name, href: parts.length ? `${b}/tree/${enc(ref)}` : null },
  ];
  let acc = "";
  parts.forEach((part, i) => {
    acc = acc ? `${acc}/${part}` : part;
    const isLast = i === parts.length - 1;
    const kind = isLast && leafIsBlob ? "blob" : "tree";
    crumbs.push({ label: part, href: isLast ? null : `${b}/${kind}/${enc(ref)}/${encPath(acc)}` });
  });
  return crumbs;
}

function cloneUrlFor(req: Request, repo: RepoSummary): string {
  return `${req.protocol}://${req.get("host")}/${repo.owner}/${repo.name}.git`;
}

// JSON feed for the command palette / client-side search.
reposRouter.get("/api/repos.json", async (_req, res, next) => {
  try {
    const repos = await listRepos();
    res.json(
      repos.map((r) => ({
        name: r.name,
        owner: r.owner,
        slug: r.slug,
        description: r.description,
        empty: r.empty,
        defaultBranch: r.defaultBranch,
      })),
    );
  } catch (err) {
    next(err);
  }
});

// Home — list all repositories.
reposRouter.get("/", async (_req, res, next) => {
  try {
    const repos = await listRepos();
    res.render("index", { repos, error: null });
  } catch (err) {
    next(err);
  }
});

// New repository form.
reposRouter.get("/new", requireAuth, (_req, res) => {
  res.render("new", { error: null, values: { name: "", description: "" } });
});

// Create a repository (under the current user's namespace).
reposRouter.post("/new", requireAuth, async (req, res, next) => {
  const name = String(req.body.name ?? "");
  const description = String(req.body.description ?? "");
  try {
    const repo = await createRepo(req.currentUser!.username, name, description);
    res.redirect(base(repo));
  } catch (err) {
    if (err instanceof RepoError) {
      res.status(err.status).render("new", { error: err.message, values: { name, description } });
      return;
    }
    next(err);
  }
});

/** Render a directory listing (used at repo root and any subdirectory). */
async function renderBrowse(
  req: Request,
  res: Response,
  repo: RepoSummary,
  ref: string,
  subpath: string,
): Promise<void> {
  const sub = cleanSubpath(subpath);
  const entries = await listDirectory(repo.slug, ref, sub);
  if (!entries) {
    res.status(404).render("404", { name: `${repo.slug}/${sub}` });
    return;
  }
  const [readme, commit, refNames] = await Promise.all([
    findReadme(repo.slug, ref, sub),
    headCommit(repo.slug, ref),
    listRefNames(repo.slug),
  ]);
  const readmeHtml = readme && isMarkdown(readme.name) ? renderMarkdown(readme.text) : null;

  res.render("browse", {
    repo,
    ref,
    subpath: sub,
    isRoot: sub === "",
    entries,
    readme,
    readmeHtml,
    commit,
    cloneUrl: cloneUrlFor(req, repo),
    crumbs: breadcrumb(repo, ref, sub, false),
    repobar: {
      repo,
      ref,
      active: "files",
      switchView: "tree",
      subpath: sub,
      branches: refNames.branches,
      tags: refNames.tags,
      branchCount: refNames.branches.length,
      tagCount: refNames.tags.length,
    },
  });
}

// User / owner page — lists the repos owned by :owner.
reposRouter.get("/:owner", async (req, res, next) => {
  try {
    const owner = String(req.params.owner);
    if (!isValidOwner(owner)) {
      res.status(404).render("404", { name: owner });
      return;
    }
    const repos = await listReposByOwner(owner);
    const user = getUser(owner);
    res.render("user", { owner, repos, displayName: user?.displayName ?? owner });
  } catch (err) {
    next(err);
  }
});

// Repository root.
reposRouter.get("/:owner/:name", async (req, res, next) => {
  try {
    const repo = await getRepo(slugOf(req));
    if (!repo) {
      res.status(404).render("404", { name: slugOf(req) });
      return;
    }
    if (repo.empty || !repo.defaultBranch) {
      res.render("repo", { repo, cloneUrl: cloneUrlFor(req, repo) });
      return;
    }
    await renderBrowse(req, res, repo, repo.defaultBranch, "");
  } catch (err) {
    next(err);
  }
});

// Browse a directory at a ref.
reposRouter.get(["/:owner/:name/tree/:ref", "/:owner/:name/tree/:ref/*"], async (req, res, next) => {
  try {
    const repo = await getRepo(slugOf(req));
    if (!repo) {
      res.status(404).render("404", { name: slugOf(req) });
      return;
    }
    const ref = String(req.params.ref);
    const sub = String((req.params as Record<string, string>)[0] ?? "");
    if (sub && (await objectType(repo.slug, ref, sub)) === "blob") {
      res.redirect(`${base(repo)}/blob/${enc(ref)}/${encPath(sub)}`);
      return;
    }
    await renderBrowse(req, res, repo, ref, sub);
  } catch (err) {
    next(err);
  }
});

// View a file at a ref.
reposRouter.get("/:owner/:name/blob/:ref/*", async (req, res, next) => {
  try {
    const repo = await getRepo(slugOf(req));
    if (!repo) {
      res.status(404).render("404", { name: slugOf(req) });
      return;
    }
    const ref = String(req.params.ref);
    const sub = String((req.params as Record<string, string>)[0] ?? "");

    if ((await objectType(repo.slug, ref, sub)) === "tree") {
      res.redirect(`${base(repo)}/tree/${enc(ref)}/${encPath(sub)}`);
      return;
    }

    const blob = await readBlob(repo.slug, ref, sub);
    if (!blob) {
      res.status(404).render("404", { name: `${repo.slug}/${sub}` });
      return;
    }
    const rawUrl = `${base(repo)}/raw/${enc(ref)}/${encPath(sub)}`;

    let highlightedHtml: string | null = null;
    let lineCount = 0;
    let language: string | null = null;
    let markdownHtml: string | null = null;
    if (blob.text !== null) {
      const body = blob.text.replace(/\n$/, "");
      lineCount = body === "" ? 1 : body.split("\n").length;
      const hl = highlightFile(body, sub);
      highlightedHtml = hl.html;
      language = hl.language;
      if (isMarkdown(sub)) markdownHtml = renderMarkdown(blob.text);
    }

    const refNames = await listRefNames(repo.slug);
    res.render("blob", {
      repo,
      ref,
      subpath: sub,
      blob,
      highlightedHtml,
      lineCount,
      language,
      markdownHtml,
      rawUrl,
      crumbs: breadcrumb(repo, ref, sub, true),
      repobar: {
        repo,
        ref,
        active: "files",
        switchView: "blob",
        subpath: sub,
        branches: refNames.branches,
        tags: refNames.tags,
        branchCount: refNames.branches.length,
        tagCount: refNames.tags.length,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Commit history (optionally filtered to a path).
reposRouter.get(
  ["/:owner/:name/commits/:ref", "/:owner/:name/commits/:ref/*"],
  async (req, res, next) => {
    try {
      const repo = await getRepo(slugOf(req));
      if (!repo) {
        res.status(404).render("404", { name: slugOf(req) });
        return;
      }
      const ref = String(req.params.ref);
      const sub = String((req.params as Record<string, string>)[0] ?? "");
      const skip = Math.max(0, Number(req.query.skip) || 0);
      const page = await listCommits(repo.slug, ref, { skip, path: sub });
      if (!page) {
        res.status(404).render("404", { name: `${repo.slug}@${ref}` });
        return;
      }
      const pathQuery = sub ? `/${encPath(sub)}` : "";
      const refNames = await listRefNames(repo.slug);
      res.render("commits", {
        repo,
        ref,
        subpath: sub,
        page,
        basePath: `${base(repo)}/commits/${enc(ref)}${pathQuery}`,
        crumbs: breadcrumb(repo, ref, sub, false),
        repobar: {
          repo,
          ref,
          active: "commits",
          switchView: "commits",
          subpath: sub,
          branches: refNames.branches,
          tags: refNames.tags,
          branchCount: refNames.branches.length,
          tagCount: refNames.tags.length,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// Branches overview.
reposRouter.get("/:owner/:name/branches", async (req, res, next) => {
  try {
    const repo = await getRepo(slugOf(req));
    if (!repo) {
      res.status(404).render("404", { name: slugOf(req) });
      return;
    }
    const branches = (await listBranches(repo.slug)) ?? [];
    const tagNames = (await listRefNames(repo.slug)).tags;
    res.render("branches", {
      repo,
      branches,
      defaultBranch: repo.defaultBranch,
      repobar: {
        repo,
        ref: repo.defaultBranch ?? "main",
        active: "branches",
        branchCount: branches.length,
        tagCount: tagNames.length,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Tags overview.
reposRouter.get("/:owner/:name/tags", async (req, res, next) => {
  try {
    const repo = await getRepo(slugOf(req));
    if (!repo) {
      res.status(404).render("404", { name: slugOf(req) });
      return;
    }
    const tags = (await listTags(repo.slug)) ?? [];
    const branchNames = (await listRefNames(repo.slug)).branches;
    res.render("tags", {
      repo,
      tags,
      repobar: {
        repo,
        ref: repo.defaultBranch ?? "main",
        active: "tags",
        branchCount: branchNames.length,
        tagCount: tags.length,
      },
    });
  } catch (err) {
    next(err);
  }
});

// A single commit with its diff.
reposRouter.get("/:owner/:name/commit/:sha", async (req, res, next) => {
  try {
    const repo = await getRepo(slugOf(req));
    if (!repo) {
      res.status(404).render("404", { name: slugOf(req) });
      return;
    }
    const commit = await getCommit(repo.slug, String(req.params.sha));
    if (!commit) {
      res.status(404).render("404", { name: `${repo.slug}@${req.params.sha}` });
      return;
    }
    res.render("commit", { repo, commit });
  } catch (err) {
    next(err);
  }
});

// Serve raw file bytes.
reposRouter.get("/:owner/:name/raw/:ref/*", async (req, res, next) => {
  try {
    const repo = await getRepo(slugOf(req));
    if (!repo) {
      res.status(404).send("repository not found");
      return;
    }
    const ref = String(req.params.ref);
    const sub = String((req.params as Record<string, string>)[0] ?? "");
    const blob = await readBlob(repo.slug, ref, sub);
    if (!blob) {
      res.status(404).send("not found");
      return;
    }
    res.setHeader(
      "Content-Type",
      blob.isBinary ? "application/octet-stream" : "text/plain; charset=utf-8",
    );
    res.setHeader("Cache-Control", "no-cache");
    res.send(blob.buffer);
  } catch (err) {
    next(err);
  }
});
