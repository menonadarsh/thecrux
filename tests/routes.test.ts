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

before(async () => {
  srv = await startServer();
});
after(async () => {
  await srv.close();
});

test("home page renders", async () => {
  const res = await fetch(`${srv.base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /repositories/i);
});

test("unknown path returns 404", async () => {
  const res = await fetch(`${srv.base}/no-such-repo-xyz`);
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

test("register, then create and view a repo", async () => {
  const user = uniqueName("u").replace(/-/g, "");
  const cookie = await registerOverHttp(srv.base, user, "correcthorse");
  const repo = uniqueName("r");

  const create = await fetch(`${srv.base}/new`, {
    ...form({ name: repo, description: "via http" }),
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
  });
  assert.equal(create.status, 302);
  assert.equal(create.headers.get("location"), `/${repo}`);

  const page = await fetch(`${srv.base}/${repo}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, new RegExp(repo));
  assert.match(html, /git clone/);

  const api = await fetch(`${srv.base}/api/repos.json`);
  const list = (await api.json()) as Array<{ name: string; owner: string | null }>;
  const found = list.find((r) => r.name === repo);
  assert.ok(found);
});

test("issues require auth to create, then render and accept comments", async () => {
  const user = uniqueName("u").replace(/-/g, "");
  const cookie = await registerOverHttp(srv.base, user, "correcthorse");
  const repo = uniqueName("r");
  await fetch(`${srv.base}/new`, {
    ...form({ name: repo }),
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
  });

  // anonymous create blocked
  const anon = await fetch(`${srv.base}/${repo}/issues`, form({ title: "x" }));
  assert.equal(anon.status, 302);
  assert.match(anon.headers.get("location") ?? "", /^\/login/);

  // authed create
  const create = await fetch(`${srv.base}/${repo}/issues`, {
    ...form({ title: "First issue", body: "**hello**" }),
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
  });
  assert.equal(create.status, 302);
  const loc = create.headers.get("location")!;
  assert.match(loc, /\/issues\/1$/);

  const page = await fetch(`${srv.base}${loc}`);
  const html = await page.text();
  assert.match(html, /First issue/);
  assert.match(html, /<strong>hello<\/strong>/); // body rendered as markdown

  const comment = await fetch(`${srv.base}${loc}/comment`, {
    ...form({ body: "a comment" }),
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
  });
  assert.equal(comment.status, 302);
  assert.match(await (await fetch(`${srv.base}${loc}`)).text(), /a comment/);
});
