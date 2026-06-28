import express from "express";
import path from "node:path";
import { loadUser } from "./auth/middleware.js";
import { config, ROOT } from "./config.js";
import { gitHttpRouter } from "./git/http.js";
import { ensureReposDir } from "./git/repos.js";
import { authRouter } from "./routes/auth.js";
import { pullsRouter } from "./routes/pulls.js";
import { reposRouter } from "./routes/repos.js";
import { encodePath, humanSize, relativeTime } from "./util/format.js";

const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(ROOT, "src", "views"));

// Git Smart-HTTP transport must see the raw request stream, so mount it before
// any body parser. Its paths (/:repo/info/refs, /:repo/git-*) don't collide
// with the web UI's single-segment routes.
app.use("/", gitHttpRouter);

app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(ROOT, "public")));

// Load the current user (from the session cookie) for every web request.
app.use(loadUser);

// Expose app metadata and view helpers to all views.
app.use((_req, res, next) => {
  res.locals.appName = config.appName;
  res.locals.humanSize = humanSize;
  res.locals.relativeTime = relativeTime;
  res.locals.encodePath = encodePath;
  next();
});

app.use("/", authRouter);
app.use("/", pullsRouter);
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
