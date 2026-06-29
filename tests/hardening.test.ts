import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { writeJsonAtomic } from "../src/util/atomic.js";
import { startServer, uniqueName, type TestServer } from "./helpers.js";

let srv: TestServer;
before(async () => {
  srv = await startServer();
});
after(async () => {
  await srv.close();
});

test("writeJsonAtomic round-trips and leaves no temp files behind", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cruxatomic-"));
  const file = path.join(dir, "data.json");

  await writeJsonAtomic(file, { a: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { a: 1 });

  // Overwriting replaces cleanly.
  await writeJsonAtomic(file, { a: 2, b: [1, 2, 3] });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { a: 2, b: [1, 2, 3] });

  // The directory holds only the target — no stray *.tmp files.
  assert.deepEqual(fs.readdirSync(dir), ["data.json"]);
});

test("the health probe responds without auth", async () => {
  const res = await fetch(`${srv.base}/healthz`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string };
  assert.equal(body.status, "ok");
});

test("security headers are present on responses", async () => {
  const res = await fetch(`${srv.base}/healthz`);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
});

test("the session cookie is HttpOnly and not Secure over plain HTTP", async () => {
  const user = uniqueName("hard").replace(/-/g, "");
  const res = await fetch(`${srv.base}/register`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: user, password: "correcthorse" }).toString(),
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /crux_session=/);
  assert.match(setCookie, /HttpOnly/i);
  // Plain HTTP (no proxy) -> not Secure, so intranet deployments keep working.
  assert.doesNotMatch(setCookie, /Secure/i);
});
