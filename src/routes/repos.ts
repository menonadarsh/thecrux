import { Router } from "express";
import { config } from "../config.js";
import { createRepo, getRepo, listRepos, RepoError } from "../git/repos.js";

export const reposRouter = Router();

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
    res.redirect(`/${encodeURIComponent(repo.name)}`);
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

// Repository detail.
reposRouter.get("/:name", async (req, res, next) => {
  try {
    const repo = await getRepo(req.params.name);
    if (!repo) {
      res.status(404).render("404", { name: req.params.name });
      return;
    }
    const cloneUrl = `${req.protocol}://${req.get("host")}/${repo.name}.git`;
    res.render("repo", { repo, cloneUrl, appName: config.appName });
  } catch (err) {
    next(err);
  }
});
