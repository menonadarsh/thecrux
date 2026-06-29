import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addCollaborator,
  canWrite,
  isOwner,
  listCollaborators,
  removeCollaborator,
} from "../src/auth/access.js";
import { createRepo } from "../src/git/repos.js";
import { uniqueName } from "./helpers.js";

test("owner has write/admin; strangers do not", async () => {
  const name = uniqueName("acl");
  const repo = await createRepo("alice", name);
  assert.equal(isOwner(repo.slug, "alice"), true);
  assert.equal(isOwner(repo.slug, "ALICE"), true); // case-insensitive
  assert.equal(isOwner(repo.slug, "bob"), false);

  assert.equal(canWrite(repo.slug, "alice"), true);
  assert.equal(canWrite(repo.slug, "bob"), false);
  assert.equal(canWrite(repo.slug, undefined), false);
});

test("collaborators get write but not owner", async () => {
  const name = uniqueName("acl");
  const repo = await createRepo("alice", name);

  await addCollaborator(repo.slug, "bob");
  assert.deepEqual(listCollaborators(repo.slug), ["bob"]);
  assert.equal(canWrite(repo.slug, "bob"), true);
  assert.equal(isOwner(repo.slug, "bob"), false);

  // idempotent + owner is never added as a collaborator
  await addCollaborator(repo.slug, "bob");
  await addCollaborator(repo.slug, "alice");
  assert.deepEqual(listCollaborators(repo.slug), ["bob"]);

  await removeCollaborator(repo.slug, "bob");
  assert.equal(canWrite(repo.slug, "bob"), false);
  assert.deepEqual(listCollaborators(repo.slug), []);
});
