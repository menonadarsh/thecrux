import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { createUser } from "../src/auth/users.js";
import { createRepo } from "../src/git/repos.js";
import {
  addWebhook,
  deliverPush,
  diffRefs,
  listWebhooks,
  removeWebhook,
} from "../src/webhooks.js";
import { startServer, uniqueName, type TestServer } from "./helpers.js";

const execFileAsync = promisify(execFile);
const ZERO = "0".repeat(40);

interface Receiver {
  url: string;
  requests: { headers: http.IncomingHttpHeaders; body: string }[];
  close: () => Promise<void>;
}

async function startReceiver(): Promise<Receiver> {
  const requests: Receiver["requests"] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ headers: req.headers, body });
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function waitFor<T>(get: () => T | undefined, ms = 2000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = get();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting for condition");
}

let srv: TestServer;
let receiver: Receiver;
before(async () => {
  srv = await startServer();
  receiver = await startReceiver();
});
after(async () => {
  await receiver.close();
  await srv.close();
});

// ---------------------------------------------------------------------------
// Unit
// ---------------------------------------------------------------------------

test("addWebhook validates the URL and stores it; remove deletes it", async () => {
  const owner = uniqueName("o").replace(/-/g, "");
  await createRepo(owner, "proj");
  const slug = `${owner}/proj`;

  await assert.rejects(() => addWebhook(slug, "not-a-url"), /valid URL/i);
  await assert.rejects(() => addWebhook(slug, "ftp://x/y"), /http or https/i);

  const hook = await addWebhook(slug, receiver.url, "shh");
  assert.equal(listWebhooks(slug).length, 1);
  assert.equal(listWebhooks(slug)[0].secret, "shh");

  await removeWebhook(slug, hook.id);
  assert.equal(listWebhooks(slug).length, 0);
});

test("diffRefs reports creates, updates and deletes", () => {
  const before = new Map([
    ["refs/heads/main", "aaa"],
    ["refs/heads/old", "bbb"],
  ]);
  const after = new Map([
    ["refs/heads/main", "ccc"], // updated
    ["refs/heads/new", "ddd"], // created
  ]);
  const changes = diffRefs(before, after).sort((a, b) => a.ref.localeCompare(b.ref));
  assert.deepEqual(changes, [
    { ref: "refs/heads/main", before: "aaa", after: "ccc" },
    { ref: "refs/heads/new", before: ZERO, after: "ddd" },
    { ref: "refs/heads/old", before: "bbb", after: ZERO },
  ]);
});

test("deliverPush posts a signed payload", async () => {
  const owner = uniqueName("o").replace(/-/g, "");
  await createRepo(owner, "proj");
  const slug = `${owner}/proj`;
  await addWebhook(slug, receiver.url, "topsecret");

  const before = receiver.requests.length;
  await deliverPush(slug, owner, [{ ref: "refs/heads/main", before: ZERO, after: "deadbeef" }]);

  const req = await waitFor(() => receiver.requests[before]);
  const payload = JSON.parse(req.body);
  assert.equal(payload.event, "push");
  assert.equal(payload.repository.slug, slug);
  assert.equal(payload.pusher, owner);
  assert.equal(payload.changes[0].ref, "refs/heads/main");

  // Signature verifies against the secret.
  const expected = "sha256=" + createHmac("sha256", "topsecret").update(req.body).digest("hex");
  assert.equal(req.headers["x-crux-signature"], expected);
  assert.equal(req.headers["x-crux-event"], "push");
});

test("deliverPush is a no-op with no hooks or no changes", async () => {
  const owner = uniqueName("o").replace(/-/g, "");
  await createRepo(owner, "proj");
  const slug = `${owner}/proj`;
  const before = receiver.requests.length;
  await deliverPush(slug, owner, [{ ref: "refs/heads/main", before: ZERO, after: "x" }]); // no hooks
  await addWebhook(slug, receiver.url);
  await deliverPush(slug, owner, []); // hook, but no changes
  assert.equal(receiver.requests.length, before);
});

// ---------------------------------------------------------------------------
// Integration: a real push over HTTP fires the webhook
// ---------------------------------------------------------------------------

test("pushing over HTTP delivers a push webhook", async () => {
  const user = uniqueName("pusher").replace(/-/g, "");
  const password = "correcthorse";
  await createUser(user, password);
  const repo = uniqueName("hooked");
  await createRepo(user, repo);
  const slug = `${user}/${repo}`;
  await addWebhook(slug, receiver.url, "sig");

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "cruxwh-"));
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const git = (args: string[]) => execFileAsync("git", args, { cwd: work, env });
  await git(["init", "-q"]);
  await git(["config", "user.email", "p@x"]);
  await git(["config", "user.name", "p"]);
  fs.writeFileSync(path.join(work, "f.txt"), "hi\n");
  await git(["add", "-A"]);
  await git(["commit", "-qm", "init"]);
  await git(["branch", "-M", "main"]);
  const url = `http://${user}:${password}@127.0.0.1:${srv.port}/${slug}.git`;

  const before = receiver.requests.length;
  await git(["push", "-q", url, "main"]);

  const req = await waitFor(() => receiver.requests[before], 4000);
  const payload = JSON.parse(req.body);
  assert.equal(payload.repository.slug, slug);
  assert.equal(payload.pusher, user);
  const main = payload.changes.find((c: { ref: string }) => c.ref === "refs/heads/main");
  assert.ok(main, "expected a change for refs/heads/main");
  assert.equal(main.before, ZERO); // newly created branch
  assert.notEqual(main.after, ZERO);
});
