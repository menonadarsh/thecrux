import express from "express";
import path from "node:path";
import { config, ROOT } from "./config.js";
import { gitHttpRouter } from "./git/http.js";
import { ensureReposDir } from "./git/repos.js";
import { reposRouter } from "./routes/repos.js";

const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(ROOT, "src", "views"));

// Git Smart-HTTP transport must see the raw request stream, so mount it before
// any body parser. Its paths (/:repo/info/refs, /:repo/git-*) don't collide
// with the web UI's single-segment routes.
app.use("/", gitHttpRouter);

app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(ROOT, "public")));

// Expose app metadata to all views.
app.use((_req, res, next) => {
  res.locals.appName = config.appName;
  next();
});

app.use("/", reposRouter);

// 404 fallback.
app.use((req, res) => {
  res.status(404).render("404", { name: req.path });
});

// Error handler.
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error(err);
    res.status(500).render("error", { message: err.message });
  },
);

async function main() {
  await ensureReposDir();
  app.listen(config.port, config.host, () => {
    console.log(`${config.appName} running at http://${config.host}:${config.port}`);
    console.log(`Repositories stored in ${config.reposDir}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
