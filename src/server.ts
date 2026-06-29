import { app } from "./app.js";
import { config } from "./config.js";
import { ensureReposDir } from "./git/repos.js";

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
