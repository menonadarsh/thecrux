import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { canWrite, isOwner } from "../src/auth/access.js";
import {
  createOrg,
  getOrg,
  isOrgMember,
  isOrgOwner,
  orgsForUser,
  removeMember,
  setMember,
} from "../src/auth/orgs.js";
import { createUser } from "../src/auth/users.js";
import { createRepo } from "../src/git/repos.js";
import { registerOverHttp, startServer, uniqueName, type TestServer } from "./helpers.js";

const execFileAsync = promisify(execFile);
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
// Unit: org model + namespace
// ---------------------------------------------------------------------------

test("createOrg makes the creator an owner and guards the namespace", async () => {
  const creator = uniqueName("u").replace(/-/g, "");
  await createUser(creator, "correcthorse");
  const name = uniqueName("acme").replace(/-/g, "");

  const org = await createOrg(name, creator);
  assert.equal(org.members[creator.toLowerCase()], "owner");
  assert.equal(isOrgOwner(name, creator), true);
  assert.deepEqual(orgsForUser(creator).map((o) => o.name), [name]);

  await assert.rejects(() => createOrg(name, creator), /taken/i); // duplicate org
  await assert.rejects(() => createOrg(creator, creator), /taken by a user/i); // collides with user
  await assert.rejects(() => createOrg("admin", creator), /reserved/i); // reserved
});

test("member management with a last-owner guard", async () => {
  const owner = uniqueName("u").replace(/-/g, "");
  const member = uniqueName("u").replace(/-/g, "");
  await createUser(owner, "correcthorse");
  await createUser(member, "correcthorse");
  const name = uniqueName("team").replace(/-/g, "");
  await createOrg(name, owner);

  await setMember(name, member, "member");
  assert.equal(isOrgMember(name, member), true);
  assert.equal(isOrgOwner(name, member), false);

  // Can't strand the org without an owner.
  await assert.rejects(() => removeMember(name, owner), /last owner/i);

  // Promote the member, then the original owner can be removed.
  await setMember(name, member, "owner");
  await removeMember(name, owner);
  assert.equal(isOrgMember(name, owner), false);
});

test("org ownership flows through access checks", async () => {
  const owner = uniqueName("u").replace(/-/g, "");
  const member = uniqueName("u").replace(/-/g, "");
  const outsider = uniqueName("u").replace(/-/g, "");
  for (const u of [owner, member, outsider]) await createUser(u, "correcthorse");
  const org = uniqueName("co").replace(/-/g, "");
  await createOrg(org, owner);
  await setMember(org, member, "member");
  await createRepo(org, "proj");
  const slug = `${org}/proj`;

  assert.equal(isOwner(slug, owner), true); // org owner = repo admin
  assert.equal(isOwner(slug, member), false); // member is not an owner
  assert.equal(canWrite(slug, owner), true);
  assert.equal(canWrite(slug, member), true); // members write all org repos
  assert.equal(canWrite(slug, outsider), false);

  // Personal repos are unaffected by org logic.
  await createRepo(owner, "personal");
  assert.equal(isOwner(`${owner}/personal`, owner), true);
  assert.equal(canWrite(`${owner}/personal`, member), false);
});

// ---------------------------------------------------------------------------
// HTTP: creation, management, and an end-to-end member push
// ---------------------------------------------------------------------------

test("namespace is shared: a user can't register an org's name", async () => {
  const owner = uniqueName("u").replace(/-/g, "");
  await createUser(owner, "correcthorse");
  const org = uniqueName("ns").replace(/-/g, "");
  await createOrg(org, owner);

  const res = await form(null, "/register", { username: org, password: "correcthorse" });
  assert.equal(res.status, 400);
});

test("org settings member management is owner-only", async () => {
  const owner = uniqueName("u").replace(/-/g, "");
  const ownerCookie = await registerOverHttp(srv.base, owner, "correcthorse");
  const orgName = uniqueName("og").replace(/-/g, "");
  const created = await form(ownerCookie, "/orgs/new", { name: orgName });
  assert.equal(created.status, 302);
  assert.equal(isOrgOwner(orgName, owner), true);

  // A non-owner can't reach settings or mutate membership.
  const stranger = uniqueName("u").replace(/-/g, "");
  const strangerCookie = await registerOverHttp(srv.base, stranger, "correcthorse");
  const denied = await fetch(`${srv.base}/orgs/${orgName}/settings`, {
    headers: { cookie: strangerCookie },
    redirect: "manual",
  });
  assert.equal(denied.status, 403);
  const mutate = await form(strangerCookie, `/orgs/${orgName}/members`, { username: stranger, role: "owner" });
  assert.equal(mutate.status, 403);
});

test("a member can create and push to an org repo over HTTP; an outsider cannot", async () => {
  const owner = uniqueName("u").replace(/-/g, "");
  const member = uniqueName("u").replace(/-/g, "");
  await createUser(owner, "correcthorse");
  const memberCookie = await registerOverHttp(srv.base, member, "correcthorse");
  const org = uniqueName("hubco").replace(/-/g, "");
  await createOrg(org, owner);
  await setMember(org, member, "member");

  // The member creates a repo under the org via the web form.
  const repo = uniqueName("svc");
  const create = await form(memberCookie, "/new", { owner: org, name: repo, visibility: "private" });
  assert.equal(create.status, 302);
  assert.equal(create.headers.get("location"), `/${org}/${repo}`);

  // The member pushes over HTTP using their credentials.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "cruxorg-"));
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (args: string[]) => execFileAsync("git", args, { cwd: work, env });
  await git(["init", "-q"]);
  await git(["config", "user.email", "m@x"]);
  await git(["config", "user.name", "m"]);
  fs.writeFileSync(path.join(work, "f.txt"), "org push\n");
  await git(["add", "-A"]);
  await git(["commit", "-qm", "init"]);
  const memberUrl = `http://${member}:correcthorse@127.0.0.1:${srv.port}/${org}/${repo}.git`;
  await git(["push", "-q", memberUrl, "HEAD:main"]); // succeeds

  // An outsider with valid credentials but no membership is refused.
  const outsider = uniqueName("u").replace(/-/g, "");
  await createUser(outsider, "correcthorse");
  const outsiderUrl = `http://${outsider}:correcthorse@127.0.0.1:${srv.port}/${org}/${repo}.git`;
  await assert.rejects(() => git(["push", "-q", outsiderUrl, "HEAD:main"]));
});
