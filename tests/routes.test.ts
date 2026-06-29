import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { registerOverHttp, startServer, uniqueName, type TestServer } from "./helpers.js";

let srv: TestServer;
const form = (data: Record<string, string>) => ({
  method: "POST",
  redirect: "manual" as const,
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(data).toString(),
});
const authed = (cookie: string, data: Record<string, string>) => ({
  ...form(data),
  headers: { "content-type": "application/x-www-form-urlencoded", cookie },
});

before(async () => {
  srv = await startServer();
});
after(async () => {
  await srv.close();
});

test("home page renders", async () => {
  const res = await fetch(`${srv.base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /the crux is in the/i);
});

test("unknown repo returns 404", async () => {
  const res = await fetch(`${srv.base}/ghostowner/ghostrepo`);
  assert.equal(res.status, 404);
});

test("creating a repo requires auth", async () => {
  const res = await fetch(`${srv.base}/new`, { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location") ?? "", /^\/login/);
});

test("login with bad credentials is rejected", async () => {
  const res = await fetch(`${srv.base}/login`, form({ username: "ghost", password: "nope" }));
  assert.equal(res.status, 401);
});

test("register, then create and view a namespaced repo", async () => {
  const user = uniqueName("u").replace(/-/g, "");
  const cookie = await registerOverHttp(srv.base, user, "correcthorse");
  const repo = uniqueName("r");

  const create = await fetch(
    `${srv.base}/new`,
    authed(cookie, { name: repo, description: "via http", visibility: "public" }),
  );
  assert.equal(create.status, 302);
  assert.equal(create.headers.get("location"), `/${user}/${repo}`);

  const page = await fetch(`${srv.base}/${user}/${repo}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, new RegExp(repo));
  assert.match(html, /git clone/);

  // owner page lists the repo
  const userPage = await fetch(`${srv.base}/${user}`);
  assert.equal(userPage.status, 200);
  assert.match(await userPage.text(), new RegExp(repo));

  const api = await fetch(`${srv.base}/api/repos.json`);
  const list = (await api.json()) as Array<{ slug: string }>;
  assert.ok(list.find((r) => r.slug === `${user}/${repo}`));
});

test("private repos are hidden from anonymous and non-member users", async () => {
  const user = uniqueName("u").replace(/-/g, "");
  const cookie = await registerOverHttp(srv.base, user, "correcthorse");
  const repo = uniqueName("r");

  // Default visibility is private.
  await fetch(`${srv.base}/new`, authed(cookie, { name: repo }));
  const repoPath = `/${user}/${repo}`;

  // Anonymous: 404 (existence not leaked).
  assert.equal((await fetch(`${srv.base}${repoPath}`)).status, 404);

  // Not listed on the public home page or the JSON feed.
  assert.doesNotMatch(await (await fetch(`${srv.base}/`)).text(), new RegExp(repo));
  const list = (await (await fetch(`${srv.base}/api/repos.json`)).json()) as Array<{ slug: string }>;
  assert.ok(!list.find((r) => r.slug === `${user}/${repo}`));

  // A non-member, even authenticated, also gets 404.
  const stranger = uniqueName("u").replace(/-/g, "");
  const strangerCookie = await registerOverHttp(srv.base, stranger, "correcthorse");
  const asStranger = await fetch(`${srv.base}${repoPath}`, { headers: { cookie: strangerCookie } });
  assert.equal(asStranger.status, 404);

  // The owner can see it.
  const asOwner = await fetch(`${srv.base}${repoPath}`, { headers: { cookie } });
  assert.equal(asOwner.status, 200);
  assert.match(await asOwner.text(), new RegExp(repo));
});

test("issues require auth to create, then render and accept comments", async () => {
  const user = uniqueName("u").replace(/-/g, "");
  const cookie = await registerOverHttp(srv.base, user, "correcthorse");
  const repo = uniqueName("r");
  await fetch(`${srv.base}/new`, authed(cookie, { name: repo, visibility: "public" }));
  const repoPath = `/${user}/${repo}`;

  const anon = await fetch(`${srv.base}${repoPath}/issues`, form({ title: "x" }));
  assert.equal(anon.status, 302);
  assert.match(anon.headers.get("location") ?? "", /^\/login/);

  const create = await fetch(`${srv.base}${repoPath}/issues`, authed(cookie, {
    title: "First issue",
    body: "**hello**",
  }));
  assert.equal(create.status, 302);
  const loc = create.headers.get("location")!;
  assert.match(loc, /\/issues\/1$/);

  const page = await fetch(`${srv.base}${loc}`);
  const html = await page.text();
  assert.match(html, /First issue/);
  assert.match(html, /<strong>hello<\/strong>/);

  const comment = await fetch(`${srv.base}${loc}/comment`, authed(cookie, { body: "a comment" }));
  assert.equal(comment.status, 302);
  assert.match(await (await fetch(`${srv.base}${loc}`)).text(), /a comment/);
});

test("a writer can set labels & assignees; a stranger cannot", async () => {
  const user = uniqueName("u").replace(/-/g, "");
  const cookie = await registerOverHttp(srv.base, user, "correcthorse");
  const repo = uniqueName("r");
  await fetch(`${srv.base}/new`, authed(cookie, { name: repo, visibility: "public" }));
  const create = await fetch(`${srv.base}/${user}/${repo}/issues`, authed(cookie, { title: "Labeled" }));
  const loc = create.headers.get("location")!; // /:user/:repo/issues/1

  // owner (writer) sets a default label + assigns themselves
  const edit = await fetch(`${srv.base}${loc}/edit`, authed(cookie, { labels: "bug", assignees: user }));
  assert.equal(edit.status, 302);
  const html = await (await fetch(`${srv.base}${loc}`)).text();
  assert.match(html, /label-chip[^>]*>bug</);
  assert.match(html, new RegExp(`@${user}`));

  // unknown labels are ignored
  await fetch(`${srv.base}${loc}/edit`, authed(cookie, { labels: "not-a-real-label" }));
  const html2 = await (await fetch(`${srv.base}${loc}`)).text();
  assert.doesNotMatch(html2, /not-a-real-label/);

  // a different user without write access is rejected
  const stranger = uniqueName("u").replace(/-/g, "");
  const strangerCookie = await registerOverHttp(srv.base, stranger, "correcthorse");
  const denied = await fetch(`${srv.base}${loc}/edit`, authed(strangerCookie, { labels: "bug" }));
  assert.equal(denied.status, 403);
});
