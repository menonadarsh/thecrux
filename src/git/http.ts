import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import { normalizeRepoName } from "./repos.js";

const execFileAsync = promisify(execFile);

/**
 * Git Smart-HTTP transport.
 *
 * Implements the four endpoints git's HTTP transport speaks, by proxying to the
 * local `git upload-pack` / `git receive-pack` processes in `--stateless-rpc`
 * mode. This makes `git clone`, `git fetch` and `git push` work against thecrux
 * using the exact same on-disk bare repositories the web UI manages.
 *
 *   GET  /:repo/info/refs?service=git-upload-pack    ref advertisement (fetch)
 *   GET  /:repo/info/refs?service=git-receive-pack   ref advertisement (push)
 *   POST /:repo/git-upload-pack                       fetch negotiation
 *   POST /:repo/git-receive-pack                      push
 */

const VALID_SERVICES = new Set(["git-upload-pack", "git-receive-pack"]);

/** Encode a string as a git pkt-line (4-byte hex length prefix + payload). */
function pktLine(line: string): Buffer {
  const length = (Buffer.byteLength(line) + 4).toString(16).padStart(4, "0");
  return Buffer.from(length + line);
}

/** The pkt-line flush packet. */
const FLUSH = Buffer.from("0000");

/** Resolve a URL repo segment (e.g. "foo.git" or "foo") to an existing bare dir. */
function resolveRepoDir(repoParam: string): string | null {
  const bareName = repoParam.replace(/\.git$/, "");
  let name: string;
  try {
    name = normalizeRepoName(bareName);
  } catch {
    return null;
  }
  const dir = path.join(config.reposDir, `${name}.git`);
  return fs.existsSync(dir) ? dir : null;
}

/**
 * After a push, a freshly-created bare repo may still have HEAD pointing at an
 * unborn branch (e.g. it was init'd as `main` but the client pushed `master`).
 * Repoint HEAD at a real branch so the repo no longer looks empty.
 */
async function repairHead(dir: string): Promise<void> {
  try {
    const head = (await execFileAsync("git", ["-C", dir, "symbolic-ref", "HEAD"])).stdout.trim();
    const branch = head.replace(/^refs\/heads\//, "");
    await execFileAsync("git", ["-C", dir, "rev-parse", "--verify", branch]);
    return; // HEAD already resolves — nothing to do.
  } catch {
    // HEAD is unborn; fall through and pick an existing branch.
  }

  try {
    const out = (
      await execFileAsync("git", ["-C", dir, "for-each-ref", "--format=%(refname:short)", "refs/heads"])
    ).stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (out.length === 0) return;
    const preferred = out.find((b) => b === "main") ?? out.find((b) => b === "master") ?? out[0];
    await execFileAsync("git", ["-C", dir, "symbolic-ref", "HEAD", `refs/heads/${preferred}`]);
  } catch (err) {
    console.error("repairHead failed:", err);
  }
}

export const gitHttpRouter = Router();

// Ref advertisement (the first request of any clone/fetch/push).
gitHttpRouter.get("/:repo/info/refs", (req: Request, res: Response) => {
  const service = String(req.query.service ?? "");
  if (!VALID_SERVICES.has(service)) {
    // We only support the smart protocol.
    res.status(400).send("thecrux only supports the git smart HTTP protocol");
    return;
  }
  const dir = resolveRepoDir(String(req.params.repo));
  if (!dir) {
    res.status(404).send("repository not found");
    return;
  }

  res.setHeader("Content-Type", `application/x-${service}-advertisement`);
  res.setHeader("Cache-Control", "no-cache");
  res.status(200);
  // Smart-HTTP advertisement preamble.
  res.write(pktLine(`# service=${service}\n`));
  res.write(FLUSH);

  const subcommand = service.replace(/^git-/, "");
  const child = spawn("git", [subcommand, "--stateless-rpc", "--advertise-refs", dir]);
  child.stdout.pipe(res);
  child.stderr.on("data", (d) => console.error(`git ${subcommand}:`, d.toString()));
  child.on("error", (err) => {
    console.error("git spawn error:", err);
    res.end();
  });
});

/** Build a POST handler that streams a request through a git RPC process. */
function rpcHandler(service: string) {
  return (req: Request, res: Response) => {
    const dir = resolveRepoDir(String(req.params.repo));
    if (!dir) {
      res.status(404).send("repository not found");
      return;
    }

    res.setHeader("Content-Type", `application/x-${service}-result`);
    res.setHeader("Cache-Control", "no-cache");

    const subcommand = service.replace(/^git-/, "");
    const child = spawn("git", [subcommand, "--stateless-rpc", dir]);

    // git may gzip the request body.
    const encoding = req.headers["content-encoding"];
    const gzipped = Array.isArray(encoding)
      ? encoding.includes("gzip")
      : encoding === "gzip";
    const body = gzipped ? req.pipe(zlib.createGunzip()) : req;
    body.pipe(child.stdin);

    child.stdout.pipe(res);
    child.stderr.on("data", (d) => console.error(`git ${subcommand}:`, d.toString()));
    child.on("error", (err) => {
      console.error("git spawn error:", err);
      res.end();
    });
    child.on("close", () => {
      if (service === "git-receive-pack") {
        // Keep dumb-http info fresh and make sure HEAD points at a real branch.
        execFile("git", ["-C", dir, "update-server-info"], () => {});
        void repairHead(dir);
      }
    });
  };
}

gitHttpRouter.post("/:repo/git-upload-pack", rpcHandler("git-upload-pack"));
gitHttpRouter.post("/:repo/git-receive-pack", rpcHandler("git-receive-pack"));
