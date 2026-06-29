import assert from "node:assert/strict";
import { test } from "node:test";
import { createSession, readSession } from "../src/auth/session.js";

test("a fresh session round-trips to its username", () => {
  const token = createSession("ada");
  assert.equal(readSession(token), "ada");
});

test("tampered or malformed tokens are rejected", () => {
  const token = createSession("ada");
  assert.equal(readSession(token + "x"), null); // bad signature
  assert.equal(readSession(token.replace(/\.[^.]+$/, ".deadbeef")), null);
  assert.equal(readSession("not-a-token"), null);
  assert.equal(readSession(""), null);
  assert.equal(readSession(undefined), null);
});

test("a forged payload without a valid signature is rejected", () => {
  const forged = Buffer.from(`root|${Date.now() + 100000}`).toString("base64url") + ".forged";
  assert.equal(readSession(forged), null);
});
