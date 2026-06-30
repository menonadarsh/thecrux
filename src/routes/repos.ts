import { Router, type Request, type Response } from "express";
import { recordReq } from "../audit.js";
import { requireAuth } from "../auth/middleware.js";
import { getCommit, listCommits } from "../git/history.js";
import { listBranches, listRefNames, listTags } from "../git/refs.js";
import {
  createRepo,
  deleteRepo,
  getRepo,
  listRepos,
  listReposByOwner,
  renameRepo,
  RepoError,
  transferRepo,
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
import { config } from "../config.js";
import { isValidOwner } from "../git/exec.js";
import { getUser } from "../auth/users.js";
import {
  addCollaborator,
  canReadSummary,
  isOwner,
  listCollaborators,
  removeCollaborator,
  setArchived,
  setPrivate,
} from "../auth/access.js";
import { loadReadableRepo } from "../auth/guard.js";
import { addWebhook, listWebhooks, removeWebhook, WebhookError } from "../webhooks.js";
import {
  addLabel,
  isValidColor,
  isValidLabelName,
  listLabels,
  removeLabel,
} from "../repo/labels.js";
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

/** SSH clone URL on this host (same hostname as the web request, SSH port), or null when SSH is off. */
function sshCloneUrlFor(req: Request, repo: RepoSummary): string | null {
  if (!config.ssh.enabled) return null;
  return `ssh://git@${req.hostname}:${config.ssh.port}/${repo.owner}/${repo.name}.git`;
}

// JSON feed for the command palette / client-side search.
reposRouter.get("/api/repos.json", async (req, res, next) => {
  try {
    const username = req.currentUser?.username;
    const repos = (await listRepos()).filter((r) => canReadSummary(r, username));
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
reposRouter.get("/", async (req, res, next) => {
  try {
    // Logged-out visitors get the marketing landing page; signed-in users
    // land straight on their repository list.
    if (!res.locals.currentUser) {
      // A representative clone URL on this host, to make the Smart-HTTP pitch
      // concrete. Mirrors cloneUrlFor() but for an illustrative repo.
      const cloneUrl = `${req.protocol}://${req.get("host")}/you/atlas.git`;
      res.render("landing", { cloneUrl });
      return;
    }
    const username = req.currentUser?.username;
    const repos = (await listRepos()).filter((r) => canReadSummary(r, username));
    res.render("index", { repos, error: null });
  } catch (err) {
    next(err);
  }
});

// New repository form.
reposRouter.get("/new", requireAuth, (_req, res) => {
  res.render("new", { error: null, values: { name: "", description: "", visibility: "private" } });
});

// Create a repository (under the current user's namespace).
reposRouter.post("/new", requireAuth, async (req, res, next) => {
  const name = String(req.body.name ?? "");
  const description = String(req.body.description ?? "");
  const visibility = String(req.body.visibility ?? "private");
  try {
    const repo = await createRepo(req.currentUser!.username, name, description, {
      private: visibility !== "public",
    });
    recordReq(req, "repo.create", { target: repo.slug, detail: repo.private ? "private" : "public" });
    res.redirect(base(repo));
  } catch (err) {
    if (err instanceof RepoError) {
      res
        .status(err.status)
        .render("new", { error: err.message, values: { name, description, visibility } });
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
    sshCloneUrl: sshCloneUrlFor(req, repo),
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
    const username = req.currentUser?.username;
    const repos = (await listReposByOwner(owner)).filter((r) => canReadSummary(r, username));
    const user = getUser(owner);
    res.render("user", { owner, repos, displayName: user?.displayName ?? owner });
  } catch (err) {
    next(err);
  }
});

// Repository root.
reposRouter.get("/:owner/:name", async (req, res, next) => {
  try {
    const repo = await loadReadableRepo(req, res);
    if (!repo) return;
    if (repo.empty || !repo.defaultBranch) {
      res.render("repo", {
        repo,
        cloneUrl: cloneUrlFor(req, repo),
        sshCloneUrl: sshCloneUrlFor(req, repo),
      });
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
    const repo = await loadReadableRepo(req, res);
    if (!repo) return;
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
    const repo = await loadReadableRepo(req, res);
    if (!repo) return;
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
      const repo = await loadReadableRepo(req, res);
      if (!repo) return;
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
    const repo = await loadReadableRepo(req, res);
    if (!repo) return;
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
    const repo = await loadReadableRepo(req, res);
    if (!repo) return;
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
    const repo = await loadReadableRepo(req, res);
    if (!repo) return;
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

/** Build the settings view, with an optional error message. */
async function renderSettings(
  req: Request,
  res: Response,
  repo: RepoSummary,
  error: string | null = null,
  status = 200,
): Promise<void> {
  const refNames = await listRefNames(repo.slug);
  res.status(status).render("settings", {
    repo,
    collaborators: listCollaborators(repo.slug),
    labels: listLabels(repo.slug),
    webhooks: listWebhooks(repo.slug),
    error,
    repobar: {
      repo,
      ref: repo.defaultBranch ?? "main",
      active: "settings",
      branchCount: refNames.branches.length,
      tagCount: refNames.tags.length,
    },
  });
}

/** Gate a settings action: must be signed in AND the repo owner. */
async function requireOwner(req: Request, res: Response): Promise<RepoSummary | null> {
  const repo = await getRepo(slugOf(req));
  if (!repo) {
    res.status(404).render("404", { name: slugOf(req) });
    return null;
  }
  if (!isOwner(repo.slug, req.currentUser?.username)) {
    res.status(403).render("error", { message: "Only the repository owner can change settings." });
    return null;
  }
  return repo;
}

// Repository settings (owner only) — manage collaborators.
reposRouter.get("/:owner/:name/settings", requireAuth, async (req, res, next) => {
  try {
    const repo = await requireOwner(req, res);
    if (!repo) return;
    await renderSettings(req, res, repo);
  } catch (err) {
    next(err);
  }
});

// Change repository visibility (public <-> private).
reposRouter.post("/:owner/:name/settings/visibility", requireAuth, async (req, res, next) => {
  try {
    const repo = await requireOwner(req, res);
    if (!repo) return;
    const makePrivate = String(req.body.visibility ?? "private") !== "public";
    await setPrivate(repo.slug, makePrivate);
    recordReq(req, "repo.visibility", { target: repo.slug, detail: makePrivate ? "private" : "public" });
    res.redirect(`${base(repo)}/settings`);
  } catch (err) {
    next(err);
  }
});

reposRouter.post("/:owner/:name/settings/collaborators", requireAuth, async (req, res, next) => {
  try {
    const repo = await requireOwner(req, res);
    if (!repo) return;
    const username = String(req.body.username ?? "").trim();
    if (!username) return void (await renderSettings(req, res, repo, "Enter a username.", 400));
    if (!getUser(username)) {
      return void (await renderSettings(req, res, repo, `No such user '${username}'.`, 400));
    }
    if (isOwner(repo.slug, username)) {
      return void (await renderSettings(req, res, repo, "The owner already has full access.", 400));
    }
    await addCollaborator(repo.slug, getUser(username)!.username);
    recordReq(req, "collaborator.add", { target: repo.slug, detail: getUser(username)!.username });
    res.redirect(`${base(repo)}/settings`);
  } catch (err) {
    next(err);
  }
});

reposRouter.post(
  "/:owner/:name/settings/collaborators/remove",
  requireAuth,
  async (req, res, next) => {
    try {
      const repo = await requireOwner(req, res);
      if (!repo) return;
      const removed = String(req.body.username ?? "");
      await removeCollaborator(repo.slug, removed);
      recordReq(req, "collaborator.remove", { target: repo.slug, detail: removed });
      res.redirect(`${base(repo)}/settings`);
    } catch (err) {
      next(err);
    }
  },
);

reposRouter.post("/:owner/:name/settings/labels", requireAuth, async (req, res, next) => {
  try {
    const repo = await requireOwner(req, res);
    if (!repo) return;
    const name = String(req.body.name ?? "").trim();
    const color = String(req.body.color ?? "").trim();
    if (!isValidLabelName(name)) {
      return void (await renderSettings(req, res, repo, "Invalid label name.", 400));
    }
    if (!isValidColor(color)) {
      return void (await renderSettings(req, res, repo, "Color must be a hex value like #2f81f7.", 400));
    }
    await addLabel(repo.slug, name, color);
    res.redirect(`${base(repo)}/settings`);
  } catch (err) {
    next(err);
  }
});

reposRouter.post("/:owner/:name/settings/labels/remove", requireAuth, async (req, res, next) => {
  try {
    const repo = await requireOwner(req, res);
    if (!repo) return;
    await removeLabel(repo.slug, String(req.body.name ?? ""));
    res.redirect(`${base(repo)}/settings`);
  } catch (err) {
    next(err);
  }
});

// Add a webhook.
reposRouter.post("/:owner/:name/settings/webhooks", requireAuth, async (req, res, next) => {
  try {
    const repo = await requireOwner(req, res);
    if (!repo) return;
    const hook = await addWebhook(repo.slug, String(req.body.url ?? ""), String(req.body.secret ?? ""));
    recordReq(req, "webhook.add", { target: repo.slug, detail: hook.url });
    res.redirect(`${base(repo)}/settings`);
  } catch (err) {
    if (err instanceof WebhookError) {
      const repo = await getRepo(slugOf(req));
      if (repo) return void (await renderSettings(req, res, repo, err.message, 400));
    }
    next(err);
  }
});

// Remove a webhook.
reposRouter.post("/:owner/:name/settings/webhooks/remove", requireAuth, async (req, res, next) => {
  try {
    const repo = await requireOwner(req, res);
    if (!repo) return;
    await removeWebhook(repo.slug, String(req.body.id ?? ""));
    recordReq(req, "webhook.remove", { target: repo.slug });
    res.redirect(`${base(repo)}/settings`);
  } catch (err) {
    next(err);
  }
});

// Archive / unarchive (read-only toggle).
reposRouter.post("/:owner/:name/settings/archive", requireAuth, async (req, res, next) => {
  try {
    const repo = await requireOwner(req, res);
    if (!repo) return;
    const archive = String(req.body.archive ?? "") === "1";
    await setArchived(repo.slug, archive);
    recordReq(req, "repo.archive", { target: repo.slug, detail: archive ? "archived" : "unarchived" });
    res.redirect(`${base(repo)}/settings`);
  } catch (err) {
    next(err);
  }
});

// Rename within the same owner.
reposRouter.post("/:owner/:name/settings/rename", requireAuth, async (req, res, next) => {
  try {
    const repo = await requireOwner(req, res);
    if (!repo) return;
    const renamed = await renameRepo(repo.owner, repo.name, String(req.body.name ?? ""));
    recordReq(req, "repo.rename", { target: renamed.slug, detail: `from ${repo.slug}` });
    res.redirect(`${base(renamed)}/settings`);
  } catch (err) {
    if (err instanceof RepoError) {
      const repo = await getRepo(slugOf(req));
      if (repo) return void (await renderSettings(req, res, repo, err.message, err.status));
    }
    next(err);
  }
});

// Transfer to another owner.
reposRouter.post("/:owner/:name/settings/transfer", requireAuth, async (req, res, next) => {
  try {
    const repo = await requireOwner(req, res);
    if (!repo) return;
    const newOwner = String(req.body.owner ?? "").trim();
    const target = getUser(newOwner);
    if (!target) {
      return void (await renderSettings(req, res, repo, `No such user '${newOwner}'.`, 400));
    }
    const moved = await transferRepo(repo.owner, repo.name, target.username);
    recordReq(req, "repo.transfer", { target: moved.slug, detail: `from ${repo.slug}` });
    res.redirect(base(moved));
  } catch (err) {
    if (err instanceof RepoError) {
      const repo = await getRepo(slugOf(req));
      if (repo) return void (await renderSettings(req, res, repo, err.message, err.status));
    }
    next(err);
  }
});

// Permanently delete (type-to-confirm with "owner/name").
reposRouter.post("/:owner/:name/settings/delete", requireAuth, async (req, res, next) => {
  try {
    const repo = await requireOwner(req, res);
    if (!repo) return;
    if (String(req.body.confirm ?? "").trim() !== repo.slug) {
      return void (await renderSettings(req, res, repo, `Type "${repo.slug}" to confirm deletion.`, 400));
    }
    await deleteRepo(repo.owner, repo.name);
    recordReq(req, "repo.delete", { target: repo.slug });
    res.redirect(`/${enc(repo.owner)}`);
  } catch (err) {
    next(err);
  }
});

// Serve raw file bytes.
reposRouter.get("/:owner/:name/raw/:ref/*", async (req, res, next) => {
  try {
    const repo = await loadReadableRepo(req, res);
    if (!repo) return;
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
