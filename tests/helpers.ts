import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { createRepo } from "../src/git/repos.js";

export interface TestServer {
  base: string;
  port: number;
  close: () => Promise<void>;
}

/** Start the real Express app on an ephemeral port for HTTP-level tests. */
export async function startServer(): Promise<TestServer> {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Extract the session cookie value from a response's Set-Cookie header. */
export function sessionCookie(res: Response): string | null {
  const raw = res.headers.get("set-cookie");
  if (!raw) return null;
  const match = raw.match(/crux_session=([^;]+)/);
  return match ? `crux_session=${match[1]}` : null;
}

/** Register a user over HTTP and return the session cookie. */
export async function registerOverHttp(
  base: string,
  username: string,
  password: string,
): Promise<string> {
  const res = await fetch(`${base}/register`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password }).toString(),
  });
  const cookie = sessionCookie(res);
  if (!cookie) throw new Error(`registration failed (${res.status})`);
  return cookie;
}

export interface SeededRepo {
  name: string;
  bare: string;
  work: string;
  /** Run a git command in the working clone. */
  git: (args: string[]) => string;
  /** Stage, commit, and push the current working tree to a branch. */
  commitAll: (message: string, branch?: string) => void;
  writeFile: (rel: string, content: string) => void;
}

/**
 * Create a bare repo via the app and a working clone pointed at it (over the
 * filesystem, so no HTTP auth is involved). Returns helpers to build history.
 */
export async function seedRepo(
  name: string,
  files: Record<string, string> = {},
): Promise<SeededRepo> {
  await createRepo(name, "", "tester");
  const bare = path.join(config.reposDir, `${name}.git`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "cruxtest-"));

  execFileSync("git", ["clone", bare, work], { stdio: "pipe" });
  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: work, stdio: "pipe" }).toString();
  git(["config", "user.email", "tester@thecrux.local"]);
  git(["config", "user.name", "tester"]);

  const writeFile = (rel: string, content: string) => {
    const fp = path.join(work, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content);
  };
  const commitAll = (message: string, branch?: string) => {
    git(["add", "-A"]);
    git(["commit", "-m", message]);
    if (branch) git(["branch", "-M", branch]);
    git(["push", "origin", branch ?? "HEAD"]);
  };

  if (Object.keys(files).length > 0) {
    for (const [rel, content] of Object.entries(files)) writeFile(rel, content);
    commitAll("init", "main");
  }

  return { name, bare, work, git, commitAll, writeFile };
}

/** A unique repo name per test to keep the shared data dir collision-free. */
let counter = 0;
export function uniqueName(prefix: string): string {
  counter += 1;
  return `${prefix}-${process.pid}-${counter}`;
}
