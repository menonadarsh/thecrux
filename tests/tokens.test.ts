import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { checkBasicAuth } from "../src/auth/middleware.js";
import {
  TOKEN_PREFIX,
  createToken,
  createUser,
  findUserByToken,
  listTokens,
  revokeToken,
} from "../src/auth/users.js";
import { registerOverHttp, startServer, uniqueName, type TestServer } from "./helpers.js";

let srv: TestServer;
const basic = (user: string, pass: string) =>
  "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

before(async () => {
  srv = await startServer();
});
after(async () => {
  await srv.close();
});

// ---------------------------------------------------------------------------
// Unit: token lifecycle
// ---------------------------------------------------------------------------

test("a created token resolves to its owner and is single-secret", async () => {
  const u = uniqueName("tok").replace(/-/g, "");
  await createUser(u, "correcthorse");

  const { secret, token } = await createToken(u, "laptop");
  assert.ok(secret.startsWith(TOKEN_PREFIX));
  assert.equal(token.tail, secret.slice(-4));

  // Stored metadata never includes the secret.
  const stored = listTokens(u)[0];
  assert.equal(stored.name, "laptop");
  assert.ok(!JSON.stringify(stored).includes(secret));

  // The secret resolves to the owner; garbage does not.
  assert.equal(findUserByToken(secret)?.username, u);
  assert.equal(findUserByToken("crux_pat_nope"), null);
  assert.equal(findUserByToken("not-even-a-token"), null);

  // Revoking it removes access.
  await revokeToken(u, token.id);
  assert.equal(listTokens(u).length, 0);
  assert.equal(findUserByToken(secret), null);
});

test("createToken requires a name", async () => {
  const u = uniqueName("tok").replace(/-/g, "");
  await createUser(u, "correcthorse");
  await assert.rejects(() => createToken(u, "   "));
});

test("Basic auth accepts a token as password or username", async () => {
  const u = uniqueName("tok").replace(/-/g, "");
  await createUser(u, "correcthorse");
  const { secret } = await createToken(u, "ci");

  // password = token (any username)
  assert.equal(checkBasicAuth(basic(u, secret))?.username, u);
  assert.equal(checkBasicAuth(basic("anything", secret))?.username, u);
  // username = token, empty password
  assert.equal(checkBasicAuth(basic(secret, ""))?.username, u);
  // the real password still works
  assert.equal(checkBasicAuth(basic(u, "correcthorse"))?.username, u);
  // wrong secret fails
  assert.equal(checkBasicAuth(basic(u, "crux_pat_wrong")), null);
});

// ---------------------------------------------------------------------------
// HTTP: account settings page
// ---------------------------------------------------------------------------

test("the settings page requires auth and manages tokens", async () => {
  // anonymous -> redirected to login
  const anon = await fetch(`${srv.base}/settings`, { redirect: "manual" });
  assert.equal(anon.status, 302);
  assert.match(anon.headers.get("location") ?? "", /^\/login/);

  const user = uniqueName("acct").replace(/-/g, "");
  const cookie = await registerOverHttp(srv.base, user, "correcthorse");

  const page = await fetch(`${srv.base}/settings`, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /personal access tokens/i);

  // Create a token — the plaintext is shown exactly once in the response.
  const created = await fetch(`${srv.base}/settings/tokens`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ name: "laptop" }).toString(),
  });
  assert.equal(created.status, 200);
  const html = await created.text();
  const match = html.match(/crux_pat_[A-Za-z0-9_-]+/);
  assert.ok(match, "expected the new token secret in the response");
  assert.equal(findUserByToken(match![0])?.username, user);

  // Revoke it.
  const id = listTokens(user)[0].id;
  const revoked = await fetch(`${srv.base}/settings/tokens/revoke`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ id }).toString(),
  });
  assert.equal(revoked.status, 302);
  assert.equal(listTokens(user).length, 0);
});
