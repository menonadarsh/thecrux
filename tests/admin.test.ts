import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  consumeInvite,
  createInvite,
  getRegistrationPolicy,
  inviteValid,
  listInvites,
  revokeInvite,
  setRegistrationPolicy,
} from "../src/auth/instance.js";
import { adminCount, isAdmin, listUsers, setAdmin } from "../src/auth/users.js";
import { registerOverHttp, sessionCookie, startServer, uniqueName, type TestServer } from "./helpers.js";

let srv: TestServer;

const post = (base: string, cookie: string | null, path: string, data: Record<string, string>) =>
  fetch(`${base}${path}`, {
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
  // Leave registration open so other test files can register over HTTP.
  await setRegistrationPolicy("open");
  await srv.close();
});

// ---------------------------------------------------------------------------
// Unit: instance settings + invites
// ---------------------------------------------------------------------------

test("registration policy defaults to open and round-trips", async () => {
  assert.equal(getRegistrationPolicy(), "open");
  await setRegistrationPolicy("closed");
  assert.equal(getRegistrationPolicy(), "closed");
  await setRegistrationPolicy("open");
});

test("invites are single-use and revocable", async () => {
  const inv = await createInvite("alice", "for bob");
  assert.ok(inv.token);
  assert.equal(inviteValid(inv.token), true);
  assert.ok(listInvites().some((i) => i.token === inv.token));

  // Single-use: first consume succeeds, second fails.
  assert.equal(await consumeInvite(inv.token), true);
  assert.equal(await consumeInvite(inv.token), false);
  assert.equal(inviteValid(inv.token), false);

  // Revoke removes an unused invite.
  const inv2 = await createInvite("alice");
  await revokeInvite(inv2.token);
  assert.equal(inviteValid(inv2.token), false);
});

// ---------------------------------------------------------------------------
// Unit: admin role
// ---------------------------------------------------------------------------

test("there is always an admin and the first user holds it", async () => {
  // Guarantee at least one account exists (the first one ever made is admin).
  await registerOverHttp(srv.base, uniqueName("seed").replace(/-/g, ""), "correcthorse");
  const users = listUsers(); // oldest first
  assert.ok(users.length > 0);
  assert.equal(adminCount() >= 1, true);
  assert.equal(users[0].admin, true);
});

test("setAdmin grants and revokes", async () => {
  // A bootstrap admin already exists (previous test), so this user is not admin.
  const u = uniqueName("admu").replace(/-/g, "");
  await registerOverHttp(srv.base, u, "correcthorse");
  assert.equal(isAdmin(u), false);
  await setAdmin(u, true);
  assert.equal(isAdmin(u), true);
  await setAdmin(u, false);
  assert.equal(isAdmin(u), false);
});

// ---------------------------------------------------------------------------
// HTTP: admin panel gating
// ---------------------------------------------------------------------------

test("the admin panel requires admin rights", async () => {
  // anonymous -> redirected to login
  const anon = await fetch(`${srv.base}/admin`, { redirect: "manual" });
  assert.equal(anon.status, 302);
  assert.match(anon.headers.get("location") ?? "", /^\/login/);

  // ordinary user -> 403
  const user = uniqueName("plain").replace(/-/g, "");
  const cookie = await registerOverHttp(srv.base, user, "correcthorse");
  const denied = await fetch(`${srv.base}/admin`, { headers: { cookie }, redirect: "manual" });
  assert.equal(denied.status, 403);

  // admin -> 200
  await setAdmin(user, true);
  const ok = await fetch(`${srv.base}/admin`, { headers: { cookie } });
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /registration/i);
});

// ---------------------------------------------------------------------------
// HTTP: registration policy enforcement
// ---------------------------------------------------------------------------

test("admin can close registration; new sign-ups are then blocked", async () => {
  const admin = uniqueName("adm").replace(/-/g, "");
  const cookie = await registerOverHttp(srv.base, admin, "correcthorse");
  await setAdmin(admin, true);

  // Close registration via the admin endpoint.
  const set = await post(srv.base, cookie, "/admin/registration", { registration: "closed" });
  assert.equal(set.status, 302);
  assert.equal(getRegistrationPolicy(), "closed");

  // A would-be user is rejected.
  const blocked = await post(srv.base, null, "/register", {
    username: uniqueName("nope").replace(/-/g, ""),
    password: "correcthorse",
  });
  assert.equal(blocked.status, 403);
  assert.equal(sessionCookie(blocked), null);

  // Reopen and confirm sign-ups work again.
  await post(srv.base, cookie, "/admin/registration", { registration: "open" });
  assert.equal(getRegistrationPolicy(), "open");
  await registerOverHttp(srv.base, uniqueName("ok").replace(/-/g, ""), "correcthorse");
});

test("invite-only registration requires a valid, single-use invite", async () => {
  const admin = uniqueName("adm2").replace(/-/g, "");
  const cookie = await registerOverHttp(srv.base, admin, "correcthorse");
  await setAdmin(admin, true);

  await post(srv.base, cookie, "/admin/registration", { registration: "invite" });
  await post(srv.base, cookie, "/admin/invites", { note: "test invite" });
  const token = listInvites()[0].token;

  const base = { password: "correcthorse" };

  // No invite -> rejected.
  const noInvite = await post(srv.base, null, "/register", {
    ...base,
    username: uniqueName("ni").replace(/-/g, ""),
  });
  assert.equal(noInvite.status, 403);

  // Bad invite -> rejected.
  const badInvite = await post(srv.base, null, "/register", {
    ...base,
    username: uniqueName("bi").replace(/-/g, ""),
    invite: "not-a-real-token",
  });
  assert.equal(badInvite.status, 403);

  // Valid invite -> success.
  const good = await post(srv.base, null, "/register", {
    ...base,
    username: uniqueName("gi").replace(/-/g, ""),
    invite: token,
  });
  assert.equal(good.status, 302);
  assert.ok(sessionCookie(good));

  // The same invite can't be reused.
  const reuse = await post(srv.base, null, "/register", {
    ...base,
    username: uniqueName("ri").replace(/-/g, ""),
    invite: token,
  });
  assert.equal(reuse.status, 403);

  await post(srv.base, cookie, "/admin/registration", { registration: "open" });
});

// ---------------------------------------------------------------------------
// HTTP: promote / demote
// ---------------------------------------------------------------------------

test("an admin can promote and demote other users", async () => {
  const admin = uniqueName("adm3").replace(/-/g, "");
  const adminCookie = await registerOverHttp(srv.base, admin, "correcthorse");
  await setAdmin(admin, true);

  const target = uniqueName("tgt").replace(/-/g, "");
  await registerOverHttp(srv.base, target, "correcthorse");
  assert.equal(isAdmin(target), false);

  await post(srv.base, adminCookie, "/admin/users/promote", { username: target });
  assert.equal(isAdmin(target), true);

  await post(srv.base, adminCookie, "/admin/users/demote", { username: target });
  assert.equal(isAdmin(target), false);
});
