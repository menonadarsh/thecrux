import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthError, authenticate, createUser, getUser } from "../src/auth/users.js";
import { uniqueName } from "./helpers.js";

test("createUser stores a user that can authenticate", async () => {
  const name = uniqueName("user").replace(/-/g, "");
  const user = await createUser(name, "correcthorse", "Display Name");
  assert.equal(user.username, name);
  assert.equal(user.displayName, "Display Name");
  // password is hashed, never stored in the clear
  assert.match(user.passwordHash, /^scrypt\$/);
  assert.doesNotMatch(user.passwordHash, /correcthorse/);

  assert.equal(getUser(name)?.username, name);
  assert.equal(authenticate(name, "correcthorse")?.username, name);
  assert.equal(authenticate(name, "wrongpassword"), null);
  assert.equal(authenticate("nobody-here", "whatever"), null);
});

test("createUser rejects invalid input", async () => {
  await assert.rejects(() => createUser("a", "longenough"), AuthError); // username too short
  await assert.rejects(() => createUser("has space", "longenough"), AuthError);
  await assert.rejects(() => createUser("validname", "short"), AuthError); // password < 8
});

test("createUser rejects duplicates (case-insensitive)", async () => {
  const name = uniqueName("dup").replace(/-/g, "");
  await createUser(name, "correcthorse");
  await assert.rejects(() => createUser(name.toUpperCase(), "correcthorse"), AuthError);
});
