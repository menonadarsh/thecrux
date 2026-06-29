import { app } from "./app.js";
import { config } from "./config.js";
import { ensureReposDir, migrateFlatRepos } from "./git/repos.js";
import { startSshServer } from "./git/ssh.js";

async function main() {
  await ensureReposDir();
  await migrateFlatRepos();
  const server = app.listen(config.port, config.host, () => {
    console.log(`${config.appName} running at http://${config.host}:${config.port}`);
    console.log(`Repositories stored in ${config.reposDir}`);
  });

  const ssh = config.ssh.enabled ? startSshServer() : null;

  // Graceful shutdown: stop accepting connections, let in-flight requests
  // finish, then exit. Falls back to a hard exit if that takes too long.
  const shutdown = (signal: string) => {
    console.log(`\n${signal} received — shutting down…`);
    ssh?.close();
    server.close(() => process.exit(0));
    setTimeout(() => {
      console.error("Forced exit (connections did not close in time).");
      process.exit(1);
    }, 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
