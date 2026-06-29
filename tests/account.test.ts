import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  authenticate,
  changePassword,
  createUser,
  deleteUser,
  getUser,
  setDisplayName,
} from "../src/auth/users.js";
import { createRepo, listReposByOwner } from "../src/git/repos.js";
import { registerOverHttp, startServer, uniqueName, type TestServer } from "./helpers.js";

let srv: TestServer;

const post = (cookie: string | null, path: string, data: Record<string, string>) =>
  fetch(`${srv.base}${path}`, {
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
// Unit: profile / password / delete
// ---------------------------------------------------------------------------

test("changePassword verifies the current password and length", async () => {
  const u = uniqueName("pw").replace(/-/g, "");
  await createUser(u, "correcthorse");

  await assert.rejects(() => changePassword(u, "wrong", "newpassword1"));
  await assert.rejects(() => changePassword(u, "correcthorse", "short"));

  await changePassword(u, "correcthorse", "newpassword1");
  assert.equal(authenticate(u, "newpassword1")?.username, u);
  assert.equal(authenticate(u, "correcthorse"), null);
});

test("setDisplayName and deleteUser", async () => {
  const u = uniqueName("pf").replace(/-/g, "");
  await createUser(u, "correcthorse");

  await setDisplayName(u, "Grace H.");
  assert.equal(getUser(u)?.displayName, "Grace H.");

  await deleteUser(u);
  assert.equal(getUser(u), null);
});

// ---------------------------------------------------------------------------
// HTTP: settings flows
// ---------------------------------------------------------------------------

test("a user can update their display name and password", async () => {
  const u = uniqueName("acc").replace(/-/g, "");
  const cookie = await registerOverHttp(srv.base, u, "correcthorse");

  const prof = await post(cookie, "/settings/profile", { displayName: "Ada L." });
  assert.equal(prof.status, 302);
  assert.match(prof.headers.get("location") ?? "", /saved=profile/);
  assert.equal(getUser(u)?.displayName, "Ada L.");

  // Wrong current password is rejected.
  const bad = await post(cookie, "/settings/password", {
    currentPassword: "nope",
    newPassword: "brandnewpass",
  });
  assert.equal(bad.status, 400);

  // Correct change works, and the new password authenticates.
  const ok = await post(cookie, "/settings/password", {
    currentPassword: "correcthorse",
    newPassword: "brandnewpass",
  });
  assert.equal(ok.status, 302);
  const login = await post(null, "/login", { username: u, password: "brandnewpass" });
  assert.equal(login.status, 302);
});

test("deleting an account removes the user and all of its repos", async () => {
  const u = uniqueName("del").replace(/-/g, "");
  const cookie = await registerOverHttp(srv.base, u, "correcthorse");
  await createRepo(u, "keepsake");
  assert.equal((await listReposByOwner(u)).length, 1);

  // Wrong confirmation is rejected.
  const bad = await post(cookie, "/settings/delete", { confirm: "not-my-name" });
  assert.equal(bad.status, 400);
  assert.ok(getUser(u), "account should still exist after a failed confirm");

  // Correct confirmation deletes the account and its repositories.
  const ok = await post(cookie, "/settings/delete", { confirm: u });
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get("location"), "/");
  assert.equal(getUser(u), null);
  assert.equal((await listReposByOwner(u)).length, 0);
});
