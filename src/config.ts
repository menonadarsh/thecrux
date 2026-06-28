import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Project root (one level up from src/ or dist/). */
export const ROOT = path.resolve(__dirname, "..");

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "127.0.0.1",

  /** Directory where bare git repositories are stored. */
  reposDir: process.env.CRUX_REPOS_DIR ?? path.join(ROOT, "data", "repos"),

  /** Public-facing name. */
  appName: "thecrux",
};
