import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { addSshKey, createUser } from "../src/auth/users.js";
import { createRepo } from "../src/git/repos.js";
import { startSshServer } from "../src/git/ssh.js";
import { uniqueName } from "./helpers.js";

const execFileAsync = promisify(execFile);

let server: ReturnType<typeof startSshServer>;
let port: number;

const SSH_OPTS =
  "-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes -o BatchMode=yes -o LogLevel=ERROR";

function envFor(idPath: string) {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_SSH_COMMAND: `ssh -i ${idPath} ${SSH_OPTS}`,
  };
}

// IMPORTANT: async — the SSH server runs in this same process, so a synchronous
// git call would block the event loop and deadlock against it.
async function git(cwd: string, args: string[], idPath: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: envFor(idPath) });
  return stdout;
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cruxssh-"));
}

/** Generate a throwaway ed25519 identity; returns its private path + public line. */
function makeIdentity(): { idPath: string; pub: string } {
  const dir = tmpdir();
  const idPath = path.join(dir, "id");
  execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", idPath]);
  return { idPath, pub: fs.readFileSync(`${idPath}.pub`, "utf8").trim() };
}

function url(slug: string): string {
  return `ssh://git@127.0.0.1:${port}/${slug}.git`;
}

let owner: string;
let ownerId: string;

before(async () => {
  server = startSshServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  port = (server.address() as AddressInfo).port;

  owner = uniqueName("owner").replace(/-/g, "");
  await createUser(owner, "correcthorse");
  const id = makeIdentity();
  ownerId = id.idPath;
  await addSshKey(owner, id.pub, "owner key");
});

after(() => {
  server.close();
});

test("owner can push to and clone a private repo over SSH", async () => {
  const repo = uniqueName("priv");
  await createRepo(owner, repo); // private by default

  // Clone the empty repo, commit, push.
  const work = tmpdir();
  await git(work, ["clone", url(`${owner}/${repo}`), "w"], ownerId);
  const w = path.join(work, "w");
  await git(w, ["config", "user.email", "o@x"], ownerId);
  await git(w, ["config", "user.name", "o"], ownerId);
  fs.writeFileSync(path.join(w, "hello.txt"), "hi over ssh\n");
  await git(w, ["add", "-A"], ownerId);
  await git(w, ["commit", "-qm", "init"], ownerId);
  await git(w, ["push", "-q", "origin", "HEAD:main"], ownerId);

  // Re-clone and verify the content round-tripped.
  const dest = tmpdir();
  await git(dest, ["clone", url(`${owner}/${repo}`), "out"], ownerId);
  assert.match(fs.readFileSync(path.join(dest, "out", "hello.txt"), "utf8"), /hi over ssh/);
});

test("an unregistered key is rejected", async () => {
  const repo = uniqueName("priv");
  await createRepo(owner, repo, "", { private: false });
  const stranger = makeIdentity(); // never added to any account
  await assert.rejects(() => git(tmpdir(), ["clone", url(`${owner}/${repo}`), "x"], stranger.idPath));
});

test("a non-collaborator can clone a public repo but not push, and can't see a private one", async () => {
  // A registered user with a key, but no access to owner's repos.
  const reader = uniqueName("reader").replace(/-/g, "");
  await createUser(reader, "correcthorse");
  const id = makeIdentity();
  await addSshKey(reader, id.pub, "reader key");

  // Public repo with a commit (seeded by the owner).
  const pub = uniqueName("pub");
  await createRepo(owner, pub, "", { private: false });
  const seed = tmpdir();
  await git(seed, ["clone", url(`${owner}/${pub}`), "w"], ownerId);
  const sw = path.join(seed, "w");
  await git(sw, ["config", "user.email", "o@x"], ownerId);
  await git(sw, ["config", "user.name", "o"], ownerId);
  fs.writeFileSync(path.join(sw, "r.txt"), "readable\n");
  await git(sw, ["add", "-A"], ownerId);
  await git(sw, ["commit", "-qm", "seed"], ownerId);
  await git(sw, ["push", "-q", "origin", "HEAD:main"], ownerId);

  // Reader can clone the public repo…
  const rdir = tmpdir();
  await git(rdir, ["clone", url(`${owner}/${pub}`), "out"], id.idPath);
  assert.match(fs.readFileSync(path.join(rdir, "out", "r.txt"), "utf8"), /readable/);

  // …but cannot push to it.
  const rw = path.join(rdir, "out");
  await git(rw, ["config", "user.email", "r@x"], id.idPath);
  await git(rw, ["config", "user.name", "r"], id.idPath);
  fs.writeFileSync(path.join(rw, "sneaky.txt"), "no\n");
  await git(rw, ["add", "-A"], id.idPath);
  await git(rw, ["commit", "-qm", "sneak"], id.idPath);
  await assert.rejects(() => git(rw, ["push", "-q", "origin", "HEAD:main"], id.idPath));

  // And cannot even clone a private repo owned by someone else.
  const secret = uniqueName("secret");
  await createRepo(owner, secret); // private
  await assert.rejects(() => git(tmpdir(), ["clone", url(`${owner}/${secret}`), "y"], id.idPath));
});
