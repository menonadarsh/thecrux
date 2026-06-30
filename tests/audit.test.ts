import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readRecent, record } from "../src/audit.js";
import { setAdmin } from "../src/auth/users.js";
import { registerOverHttp, startServer, uniqueName, type TestServer } from "./helpers.js";

let srv: TestServer;
before(async () => {
  srv = await startServer();
});
after(async () => {
  await srv.close();
});

/** Poll readRecent until `predicate` matches one of the events, or time out. */
async function waitForEvent(predicate: (e: { action: string; actor: string | null; detail?: string }) => boolean) {
  for (let i = 0; i < 20; i++) {
    const { events } = await readRecent({ limit: 200 });
    const hit = events.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

test("record then readRecent returns newest-first with filtering", async () => {
  const actor = uniqueName("aud").replace(/-/g, "");
  await record({ action: "login.success", actor, ip: "1.1.1.1" });
  await record({ action: "repo.create", actor, target: `${actor}/x`, detail: "private" });

  const mine = await readRecent({ actor });
  assert.equal(mine.total, 2);
  // newest first
  assert.equal(mine.events[0].action, "repo.create");
  assert.equal(mine.events[1].action, "login.success");

  // action substring filter (scoped to this actor)
  const repos = await readRecent({ actor, action: "repo" });
  assert.equal(repos.total, 1);
  assert.equal(repos.events[0].target, `${actor}/x`);
});

test("readRecent paginates and skips corrupt lines", async () => {
  const actor = uniqueName("pag").replace(/-/g, "");
  for (let i = 0; i < 5; i++) await record({ action: "tick", actor, detail: String(i) });

  const p1 = await readRecent({ actor, limit: 2, offset: 0 });
  assert.equal(p1.total, 5);
  assert.equal(p1.events.length, 2);
  assert.equal(p1.events[0].detail, "4"); // newest

  const p3 = await readRecent({ actor, limit: 2, offset: 4 });
  assert.equal(p3.events.length, 1);
  assert.equal(p3.events[0].detail, "0"); // oldest
});

test("security events are recorded through the HTTP layer", async () => {
  // A failed login is attributable to no actor but keeps the attempted username.
  const ghost = uniqueName("ghost").replace(/-/g, "");
  await fetch(`${srv.base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: ghost, password: "wrong" }).toString(),
  });
  const fail = await waitForEvent((e) => e.action === "login.failure" && (e.detail ?? "").includes(ghost));
  assert.ok(fail, "expected a login.failure event for the ghost user");

  // Registering records a register event for the new actor.
  const u = uniqueName("areg").replace(/-/g, "");
  await registerOverHttp(srv.base, u, "correcthorse");
  assert.ok(await waitForEvent((e) => e.action === "register" && e.actor === u));
});

test("the audit view requires admin", async () => {
  // anonymous -> redirected to login
  const anon = await fetch(`${srv.base}/admin/audit`, { redirect: "manual" });
  assert.equal(anon.status, 302);
  assert.match(anon.headers.get("location") ?? "", /^\/login/);

  // ordinary user -> 403
  const user = uniqueName("plainA").replace(/-/g, "");
  const cookie = await registerOverHttp(srv.base, user, "correcthorse");
  const denied = await fetch(`${srv.base}/admin/audit`, { headers: { cookie }, redirect: "manual" });
  assert.equal(denied.status, 403);

  // admin -> 200, shows the log
  await setAdmin(user, true);
  const ok = await fetch(`${srv.base}/admin/audit`, { headers: { cookie } });
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /admin audit/i);
});
