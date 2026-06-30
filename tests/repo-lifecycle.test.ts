import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { isArchived } from "../src/auth/access.js";
import { createUser } from "../src/auth/users.js";
import { repoDirFor } from "../src/git/exec.js";
import {
  createRepo,
  deleteRepo,
  getRepo,
  renameRepo,
  transferRepo,
} from "../src/git/repos.js";
import { registerOverHttp, startServer, uniqueName, type TestServer } from "./helpers.js";

let srv: TestServer;
const form = (cookie: string | null, p: string, data: Record<string, string>) =>
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

// ---------------------------------------------------------------------------
// Unit: repos.ts lifecycle functions
// ---------------------------------------------------------------------------

test("rename moves the repo and keeps its sidecar files", async () => {
  const owner = uniqueName("o").replace(/-/g, "");
  await createRepo(owner, "old", "", { private: true });
  // sidecar (crux-private) should travel with the rename
  assert.equal((await getRepo(`${owner}/old`))?.private, true);

  const renamed = await renameRepo(owner, "old", "new");
  assert.equal(renamed.slug, `${owner}/new`);
  assert.equal(await getRepo(`${owner}/old`), null);
  assert.equal((await getRepo(`${owner}/new`))?.private, true);

  // Renaming onto an existing name is refused.
  await createRepo(owner, "taken");
  await assert.rejects(() => renameRepo(owner, "new", "taken"), /already exists/i);
});

test("transfer moves the repo to another owner and rewrites crux-owner", async () => {
  const a = uniqueName("o").replace(/-/g, "");
  const b = uniqueName("o").replace(/-/g, "");
  await createUser(a, "correcthorse");
  await createUser(b, "correcthorse");
  await createRepo(a, "proj");

  const moved = await transferRepo(a, "proj", b);
  assert.equal(moved.slug, `${b}/proj`);
  assert.equal(await getRepo(`${a}/proj`), null);
  assert.equal((await getRepo(`${b}/proj`))?.owner, b);
  const ownerFile = fs.readFileSync(repoDirFor(b, "proj") + "/crux-owner", "utf8").trim();
  assert.equal(ownerFile, b);
});

test("delete removes the repository directory", async () => {
  const owner = uniqueName("o").replace(/-/g, "");
  await createRepo(owner, "gone");
  assert.ok(fs.existsSync(repoDirFor(owner, "gone")));
  await deleteRepo(owner, "gone");
  assert.equal(fs.existsSync(repoDirFor(owner, "gone")), false);
  assert.equal(await getRepo(`${owner}/gone`), null);
});

// ---------------------------------------------------------------------------
// HTTP: owner-only lifecycle routes
// ---------------------------------------------------------------------------

test("archive toggles read-only state via settings", async () => {
  const owner = uniqueName("a").replace(/-/g, "");
  const cookie = await registerOverHttp(srv.base, owner, "correcthorse");
  const repo = uniqueName("r");
  await form(cookie, "/new", { name: repo, visibility: "private" });
  const slug = `${owner}/${repo}`;

  const on = await form(cookie, `/${slug}/settings/archive`, { archive: "1" });
  assert.equal(on.status, 302);
  assert.equal(isArchived(slug), true);

  const off = await form(cookie, `/${slug}/settings/archive`, { archive: "0" });
  assert.equal(off.status, 302);
  assert.equal(isArchived(slug), false);
});

test("delete requires the exact slug confirmation", async () => {
  const owner = uniqueName("a").replace(/-/g, "");
  const cookie = await registerOverHttp(srv.base, owner, "correcthorse");
  const repo = uniqueName("r");
  await form(cookie, "/new", { name: repo });
  const slug = `${owner}/${repo}`;

  // wrong confirmation -> 400, repo survives
  const bad = await form(cookie, `/${slug}/settings/delete`, { confirm: "nope" });
  assert.equal(bad.status, 400);
  assert.ok(await getRepo(slug));

  // correct confirmation -> 302 to the owner page, repo gone
  const ok = await form(cookie, `/${slug}/settings/delete`, { confirm: slug });
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get("location"), `/${owner}`);
  assert.equal(await getRepo(slug), null);
});

test("a non-owner cannot run lifecycle actions", async () => {
  const owner = uniqueName("a").replace(/-/g, "");
  const ownerCookie = await registerOverHttp(srv.base, owner, "correcthorse");
  const repo = uniqueName("r");
  await form(ownerCookie, "/new", { name: repo, visibility: "public" });
  const slug = `${owner}/${repo}`;

  const stranger = uniqueName("s").replace(/-/g, "");
  const strangerCookie = await registerOverHttp(srv.base, stranger, "correcthorse");
  const denied = await form(strangerCookie, `/${slug}/settings/delete`, { confirm: slug });
  assert.equal(denied.status, 403);
  assert.ok(await getRepo(slug), "repo must survive a non-owner delete attempt");
});
