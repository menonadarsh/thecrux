import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { addCollaborator } from "../src/auth/access.js";
import { createUser } from "../src/auth/users.js";
import { createRepo } from "../src/git/repos.js";
import { startServer, uniqueName, type TestServer } from "./helpers.js";

const execFileAsync = promisify(execFile);

let srv: TestServer;
const password = "correcthorse";
let username: string;

// Isolate from the user's git config so no credential helper (e.g. macOS
// osxkeychain) intercepts auth — credentials come only from the URL.
const gitEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

// IMPORTANT: must be async. The test server runs in this same process, so a
// synchronous git call (execFileSync) would block the event loop and deadlock
// against the in-process HTTP server.
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: gitEnv });
  return stdout;
}
function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cruxhttp-"));
}
async function makeCommit(work: string, file: string, content: string, msg: string) {
  await git(work, ["init", "-q"]);
  await git(work, ["config", "user.email", "p@thecrux.local"]);
  await git(work, ["config", "user.name", "pusher"]);
  fs.writeFileSync(path.join(work, file), content);
  await git(work, ["add", "-A"]);
  await git(work, ["commit", "-q", "-m", msg]);
  await git(work, ["branch", "-M", "main"]);
}

before(async () => {
  srv = await startServer();
  username = uniqueName("pusher").replace(/-/g, "");
  await createUser(username, password);
});
after(async () => {
  await srv.close();
});

test("upload-pack ref advertisement is served (anonymous)", async () => {
  const repo = uniqueName("clone");
  await createRepo(username, repo, "", { private: false });
  const res = await fetch(`${srv.base}/${username}/${repo}.git/info/refs?service=git-upload-pack`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /x-git-upload-pack-advertisement/);
  assert.match(await res.text(), /# service=git-upload-pack/);
});

test("cloning a private repo requires auth; the owner can, a stranger cannot", async () => {
  const repo = uniqueName("priv");
  await createRepo(username, repo); // private by default

  const refsUrl = `${srv.base}/${username}/${repo}.git/info/refs?service=git-upload-pack`;

  // Anonymous: challenged for credentials.
  const anon = await fetch(refsUrl);
  assert.equal(anon.status, 401);
  assert.match(anon.headers.get("www-authenticate") ?? "", /Basic/);

  // Owner credentials: allowed.
  const ownerAuth = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
  const owner = await fetch(refsUrl, { headers: { authorization: ownerAuth } });
  assert.equal(owner.status, 200);

  // A valid but unauthorized user: hidden (404), existence not confirmed.
  const stranger = uniqueName("stranger").replace(/-/g, "");
  await createUser(stranger, password);
  const strangerAuth = "Basic " + Buffer.from(`${stranger}:${password}`).toString("base64");
  const denied = await fetch(refsUrl, { headers: { authorization: strangerAuth } });
  assert.equal(denied.status, 404);
});

test("receive-pack advertisement requires auth", async () => {
  const repo = uniqueName("push");
  await createRepo(username, repo);
  const refsUrl = `${srv.base}/${username}/${repo}.git/info/refs?service=git-receive-pack`;

  const anon = await fetch(refsUrl);
  assert.equal(anon.status, 401);
  assert.match(anon.headers.get("www-authenticate") ?? "", /Basic/);

  const authz = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
  const ok = await fetch(refsUrl, { headers: { authorization: authz } });
  assert.equal(ok.status, 200);
});

test("authenticated push then anonymous clone round-trips", async () => {
  const repo = uniqueName("rt");
  await createRepo(username, repo, "", { private: false });

  const work = tmpdir();
  await makeCommit(work, "hello.txt", "hi from a push\n", "initial");
  const authUrl = `http://${username}:${password}@127.0.0.1:${srv.port}/${username}/${repo}.git`;
  await git(work, ["push", "-q", authUrl, "main"]);

  const dest = tmpdir();
  await git(dest, ["clone", "-q", `${srv.base}/${username}/${repo}.git`, "out"]);
  const content = fs.readFileSync(path.join(dest, "out", "hello.txt"), "utf8");
  assert.match(content, /hi from a push/);
});

test("anonymous push is rejected", async () => {
  const repo = uniqueName("noauth");
  await createRepo(username, repo);

  const work = tmpdir();
  await makeCommit(work, "x.txt", "x\n", "x");
  await assert.rejects(() =>
    git(work, ["push", "-q", `${srv.base}/${username}/${repo}.git`, "main"]),
  );
});

test("pushing to another owner's repo is rejected until granted access", async () => {
  // A repo owned by someone else; our authenticated user is not a collaborator.
  const otherOwner = uniqueName("owner").replace(/-/g, "");
  await createUser(otherOwner, "correcthorse");
  const repo = uniqueName("perm");
  await createRepo(otherOwner, repo);

  const work = tmpdir();
  await makeCommit(work, "x.txt", "x\n", "x");
  const url = `http://${username}:${password}@127.0.0.1:${srv.port}/${otherOwner}/${repo}.git`;

  // Valid credentials but no write access -> rejected.
  await assert.rejects(() => git(work, ["push", "-q", url, "main"]));

  // After being added as a collaborator, the push succeeds.
  await addCollaborator(`${otherOwner}/${repo}`, username);
  await git(work, ["push", "-q", url, "main"]);
});
