import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  addSshKey,
  createUser,
  findUserBySshKey,
  listSshKeys,
  parsePublicKey,
  removeSshKey,
} from "../src/auth/users.js";
import { registerOverHttp, startServer, uniqueName, type TestServer } from "./helpers.js";

let srv: TestServer;

/** Generate a throwaway ed25519 keypair; returns the public key line. */
function makePublicKey(comment = "me@host"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cruxkey-"));
  execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", comment, "-f", path.join(dir, "id")]);
  return fs.readFileSync(path.join(dir, "id.pub"), "utf8").trim();
}

const post = (cookie: string | null, p: string, data: Record<string, string>) =>
  fetch(`${srv.base}${p}`, {
    method: "POST",
    redirect: "manual" as const,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(data).toString(),
  });

before(async () => {
  srv = await startServer();
});
after(async () => {
  await srv.close();
});

test("parsePublicKey matches ssh-keygen and rejects junk/private keys", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cruxkey-"));
  execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "x@y", "-f", path.join(dir, "id")]);
  const pub = fs.readFileSync(path.join(dir, "id.pub"), "utf8").trim();

  const parsed = parsePublicKey(pub);
  assert.equal(parsed.type, "ssh-ed25519");
  assert.equal(parsed.comment, "x@y");
  // Fingerprint must equal `ssh-keygen -lf`.
  const expected = execFileSync("ssh-keygen", ["-lf", path.join(dir, "id.pub")])
    .toString()
    .split(" ")[1];
  assert.equal(parsed.fingerprint, expected);

  assert.throws(() => parsePublicKey("not a key"));
  const priv = fs.readFileSync(path.join(dir, "id"), "utf8");
  assert.throws(() => parsePublicKey(priv)); // private key rejected
});

test("add / list / find / remove SSH keys", async () => {
  const u = uniqueName("sshk").replace(/-/g, "");
  await createUser(u, "correcthorse");
  const pub = makePublicKey();

  const key = await addSshKey(u, pub, "laptop");
  assert.equal(key.name, "laptop");
  assert.equal(listSshKeys(u).length, 1);
  // The stored record never contains a private key and is canonicalized.
  assert.match(key.publicKey, /^ssh-ed25519 [A-Za-z0-9+/]+$/);

  // Fingerprint resolves to the owner; an unknown one does not.
  assert.equal(findUserBySshKey(key.fingerprint)?.username, u);
  assert.equal(findUserBySshKey("SHA256:nope"), null);

  // The same key can't be registered twice (anywhere).
  await assert.rejects(() => addSshKey(u, pub, "again"));
  const other = uniqueName("sshk").replace(/-/g, "");
  await createUser(other, "correcthorse");
  await assert.rejects(() => addSshKey(other, pub, "stolen"));

  await removeSshKey(u, key.id);
  assert.equal(listSshKeys(u).length, 0);
  assert.equal(findUserBySshKey(key.fingerprint), null);
});

test("the settings page adds and removes SSH keys over HTTP", async () => {
  const u = uniqueName("sshh").replace(/-/g, "");
  const cookie = await registerOverHttp(srv.base, u, "correcthorse");

  // Auth required.
  const anon = await post(null, "/settings/ssh-keys", { publicKey: makePublicKey() });
  assert.equal(anon.status, 302);
  assert.match(anon.headers.get("location") ?? "", /^\/login/);

  // Invalid key is rejected with 400.
  const bad = await post(cookie, "/settings/ssh-keys", { publicKey: "garbage" });
  assert.equal(bad.status, 400);

  // Valid key is added and shown (fingerprint visible, masked-ish).
  const pub = makePublicKey("ci@runner");
  const ok = await post(cookie, "/settings/ssh-keys", { publicKey: pub, name: "ci" });
  assert.equal(ok.status, 302);
  assert.match(ok.headers.get("location") ?? "", /saved=sshkey/);

  const keys = listSshKeys(u);
  assert.equal(keys.length, 1);
  const page = await (await fetch(`${srv.base}/settings`, { headers: { cookie } })).text();
  assert.match(page, /SHA256:/);

  // Remove it.
  const removed = await post(cookie, "/settings/ssh-keys/remove", { id: keys[0].id });
  assert.equal(removed.status, 302);
  assert.equal(listSshKeys(u).length, 0);
});
