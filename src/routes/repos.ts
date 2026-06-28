import { Router, type Request, type Response } from "express";
import { getCommit, listCommits } from "../git/history.js";
import { listBranches, listRefNames, listTags } from "../git/refs.js";
import { createRepo, getRepo, listRepos, RepoError, type RepoSummary } from "../git/repos.js";
import {
  cleanSubpath,
  findReadme,
  headCommit,
  listDirectory,
  objectType,
  readBlob,
} from "../git/tree.js";
import { highlightFile } from "../render/highlight.js";
import { isMarkdown, renderMarkdown } from "../render/markdown.js";

export const reposRouter = Router();

const enc = encodeURIComponent;

/** Encode a slash-separated path, preserving the separators. */
function encPath(p: string): string {
  return cleanSubpath(p)
    .split("/")
    .filter(Boolean)
    .map(enc)
    .join("/");
}

interface Crumb {
  label: string;
  href: string | null;
}

/** Build breadcrumb segments for a path within a repo at a ref. */
function breadcrumb(repoName: string, ref: string, subpath: string, leafIsBlob: boolean): Crumb[] {
  const parts = cleanSubpath(subpath).split("/").filter(Boolean);
  const crumbs: Crumb[] = [
    { label: repoName, href: parts.length ? `/${enc(repoName)}/tree/${enc(ref)}` : null },
  ];
  let acc = "";
  parts.forEach((part, i) => {
    acc = acc ? `${acc}/${part}` : part;
    const isLast = i === parts.length - 1;
    const kind = isLast && leafIsBlob ? "blob" : "tree";
    crumbs.push({
      label: part,
      href: isLast ? null : `/${enc(repoName)}/${kind}/${enc(ref)}/${encPath(acc)}`,
    });
  });
  return crumbs;
}

// JSON feed for the command palette / client-side search.
reposRouter.get("/api/repos.json", async (_req, res, next) => {
  try {
    const repos = await listRepos();
    res.json(
      repos.map((r) => ({
        name: r.name,
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
reposRouter.get("/new", (_req, res) => {
  res.render("new", { error: null, values: { name: "", description: "" } });
});

// Create a repository.
reposRouter.post("/new", async (req, res, next) => {
  const name = String(req.body.name ?? "");
  const description = String(req.body.description ?? "");
  try {
    const repo = await createRepo(name, description);
    res.redirect(`/${enc(repo.name)}`);
  } catch (err) {
    if (err instanceof RepoError) {
      res.status(err.status).render("new", {
        error: err.message,
        values: { name, description },
      });
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
  const entries = await listDirectory(repo.name, ref, sub);
  if (!entries) {
    res.status(404).render("404", { name: `${repo.name}/${sub}` });
    return;
  }
  const [readme, commit, refNames] = await Promise.all([
    findReadme(repo.name, ref, sub),
    headCommit(repo.name, ref),
    listRefNames(repo.name),
  ]);
  const cloneUrl = `${req.protocol}://${req.get("host")}/${repo.name}.git`;
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
    cloneUrl,
    crumbs: breadcrumb(repo.name, ref, sub, false),
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

// Repository root.
reposRouter.get("/:name", async (req, res, next) => {
  try {
    const repo = await getRepo(req.params.name);
    if (!repo) {
      res.status(404).render("404", { name: req.params.name });
      return;
    }
    const cloneUrl = `${req.protocol}://${req.get("host")}/${repo.name}.git`;
    if (repo.empty || !repo.defaultBranch) {
      res.render("repo", { repo, cloneUrl });
      return;
    }
    await renderBrowse(req, res, repo, repo.defaultBranch, "");
  } catch (err) {
    next(err);
  }
});

// Browse a directory at a ref.
reposRouter.get(["/:name/tree/:ref", "/:name/tree/:ref/*"], async (req, res, next) => {
  try {
    const repo = await getRepo(req.params.name);
    if (!repo) {
      res.status(404).render("404", { name: req.params.name });
      return;
    }
    const ref = String(req.params.ref);
    const sub = String((req.params as Record<string, string>)[0] ?? "");
    // If the target is actually a file, redirect to the blob view.
    if (sub && (await objectType(repo.name, ref, sub)) === "blob") {
      res.redirect(`/${enc(repo.name)}/blob/${enc(ref)}/${encPath(sub)}`);
      return;
    }
    await renderBrowse(req, res, repo, ref, sub);
  } catch (err) {
    next(err);
  }
});

// View a file at a ref.
reposRouter.get("/:name/blob/:ref/*", async (req, res, next) => {
  try {
    const repo = await getRepo(req.params.name);
    if (!repo) {
      res.status(404).render("404", { name: req.params.name });
      return;
    }
    const ref = String(req.params.ref);
    const sub = String((req.params as Record<string, string>)[0] ?? "");

    // If the target is a directory, redirect to the tree view.
    if ((await objectType(repo.name, ref, sub)) === "tree") {
      res.redirect(`/${enc(repo.name)}/tree/${enc(ref)}/${encPath(sub)}`);
      return;
    }

    const blob = await readBlob(repo.name, ref, sub);
    if (!blob) {
      res.status(404).render("404", { name: `${repo.name}/${sub}` });
      return;
    }
    const rawUrl = `/${enc(repo.name)}/raw/${enc(ref)}/${encPath(sub)}`;

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

    const refNames = await listRefNames(repo.name);
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
      crumbs: breadcrumb(repo.name, ref, sub, true),
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
reposRouter.get(["/:name/commits/:ref", "/:name/commits/:ref/*"], async (req, res, next) => {
  try {
    const repo = await getRepo(req.params.name);
    if (!repo) {
      res.status(404).render("404", { name: req.params.name });
      return;
    }
    const ref = String(req.params.ref);
    const sub = String((req.params as Record<string, string>)[0] ?? "");
    const skip = Math.max(0, Number(req.query.skip) || 0);
    const page = await listCommits(repo.name, ref, { skip, path: sub });
    if (!page) {
      res.status(404).render("404", { name: `${repo.name}@${ref}` });
      return;
    }
    const pathQuery = sub ? `/${encPath(sub)}` : "";
    const refNames = await listRefNames(repo.name);
    res.render("commits", {
      repo,
      ref,
      subpath: sub,
      page,
      basePath: `/${enc(repo.name)}/commits/${enc(ref)}${pathQuery}`,
      crumbs: breadcrumb(repo.name, ref, sub, false),
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
});

// Branches overview.
reposRouter.get("/:name/branches", async (req, res, next) => {
  try {
    const repo = await getRepo(req.params.name);
    if (!repo) {
      res.status(404).render("404", { name: req.params.name });
      return;
    }
    const branches = (await listBranches(repo.name)) ?? [];
    const tagNames = (await listRefNames(repo.name)).tags;
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
reposRouter.get("/:name/tags", async (req, res, next) => {
  try {
    const repo = await getRepo(req.params.name);
    if (!repo) {
      res.status(404).render("404", { name: req.params.name });
      return;
    }
    const tags = (await listTags(repo.name)) ?? [];
    const branchNames = (await listRefNames(repo.name)).branches;
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
reposRouter.get("/:name/commit/:sha", async (req, res, next) => {
  try {
    const repo = await getRepo(req.params.name);
    if (!repo) {
      res.status(404).render("404", { name: req.params.name });
      return;
    }
    const commit = await getCommit(repo.name, String(req.params.sha));
    if (!commit) {
      res.status(404).render("404", { name: `${repo.name}@${req.params.sha}` });
      return;
    }
    res.render("commit", { repo, commit });
  } catch (err) {
    next(err);
  }
});

// Serve raw file bytes.
reposRouter.get("/:name/raw/:ref/*", async (req, res, next) => {
  try {
    const repo = await getRepo(req.params.name);
    if (!repo) {
      res.status(404).send("repository not found");
      return;
    }
    const ref = String(req.params.ref);
    const sub = String((req.params as Record<string, string>)[0] ?? "");
    const blob = await readBlob(repo.name, ref, sub);
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
