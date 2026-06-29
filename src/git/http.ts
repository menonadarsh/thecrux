import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { Router, type Request, type Response } from "express";
import { canRead, canWrite, isPrivate } from "../auth/access.js";
import { checkBasicAuth } from "../auth/middleware.js";
import { repoDir } from "./exec.js";

const execFileAsync = promisify(execFile);

/**
 * Pushing (receive-pack) requires authentication AND write access to the repo.
 * Returns true if allowed; otherwise sends 401 (no/invalid credentials) or 403
 * (authenticated but lacks write access) and returns false. Cloning is
 * left anonymous.
 */
function authorizePush(req: Request, res: Response, slug: string): boolean {
  const user = checkBasicAuth(req.headers.authorization);
  if (!user) {
    res.setHeader("WWW-Authenticate", 'Basic realm="thecrux"');
    res.status(401).send("Authentication required to push.");
    return false;
  }
  if (!canWrite(slug, user.username)) {
    res.status(403).send("You do not have write access to this repository.");
    return false;
  }
  return true;
}

/**
 * Cloning/fetching (upload-pack) a **private** repo requires authentication AND
 * read access; public repos stay anonymous. Returns true if allowed; otherwise
 * sends 401 (no/invalid credentials) or 404 (authenticated but not a member —
 * we don't confirm a private repo's existence) and returns false.
 */
function authorizeRead(req: Request, res: Response, slug: string): boolean {
  if (!isPrivate(slug)) return true;
  const user = checkBasicAuth(req.headers.authorization);
  if (!user) {
    res.setHeader("WWW-Authenticate", 'Basic realm="thecrux"');
    res.status(401).send("Authentication required.");
    return false;
  }
  if (!canRead(slug, user.username)) {
    res.status(404).send("repository not found");
    return false;
  }
  return true;
}

/** Build the "owner/name" slug from request params (repo may end in .git). */
function slugFromReq(req: Request): string {
  const repo = String(req.params.repo).replace(/\.git$/, "");
  return `${req.params.owner}/${repo}`;
}

/**
 * Git Smart-HTTP transport.
 *
 * Implements the four endpoints git's HTTP transport speaks, by proxying to the
 * local `git upload-pack` / `git receive-pack` processes in `--stateless-rpc`
 * mode. This makes `git clone`, `git fetch` and `git push` work against thecrux
 * using the exact same on-disk bare repositories the web UI manages.
 *
 *   GET  /:owner/:repo/info/refs?service=git-upload-pack    advertisement (fetch)
 *   GET  /:owner/:repo/info/refs?service=git-receive-pack   advertisement (push)
 *   POST /:owner/:repo/git-upload-pack                       fetch negotiation
 *   POST /:owner/:repo/git-receive-pack                      push
 */

const VALID_SERVICES = new Set(["git-upload-pack", "git-receive-pack"]);

/** Encode a string as a git pkt-line (4-byte hex length prefix + payload). */
function pktLine(line: string): Buffer {
  const length = (Buffer.byteLength(line) + 4).toString(16).padStart(4, "0");
  return Buffer.from(length + line);
}

/** The pkt-line flush packet. */
const FLUSH = Buffer.from("0000");

/** Resolve "owner" + a repo segment (e.g. "foo.git") to an existing bare dir. */
function resolveRepoDir(owner: string, repoParam: string): string | null {
  const name = repoParam.replace(/\.git$/, "");
  return repoDir(`${owner}/${name}`);
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
gitHttpRouter.get("/:owner/:repo/info/refs", (req: Request, res: Response) => {
  const service = String(req.query.service ?? "");
  if (!VALID_SERVICES.has(service)) {
    // We only support the smart protocol.
    res.status(400).send("thecrux only supports the git smart HTTP protocol");
    return;
  }
  // Pushing must be authenticated + authorized, including this advertisement.
  if (service === "git-receive-pack" && !authorizePush(req, res, slugFromReq(req))) return;
  // Cloning/fetching a private repo must be authorized too.
  if (service === "git-upload-pack" && !authorizeRead(req, res, slugFromReq(req))) return;

  const dir = resolveRepoDir(String(req.params.owner), String(req.params.repo));
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
    if (service === "git-receive-pack" && !authorizePush(req, res, slugFromReq(req))) return;
    if (service === "git-upload-pack" && !authorizeRead(req, res, slugFromReq(req))) return;

    const dir = resolveRepoDir(String(req.params.owner), String(req.params.repo));
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

gitHttpRouter.post("/:owner/:repo/git-upload-pack", rpcHandler("git-upload-pack"));
gitHttpRouter.post("/:owner/:repo/git-receive-pack", rpcHandler("git-receive-pack"));
