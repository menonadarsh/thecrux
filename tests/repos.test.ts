import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRepo,
  getRepo,
  listRepos,
  listReposByOwner,
  normalizeRepoName,
  RepoError,
} from "../src/git/repos.js";
import { uniqueName } from "./helpers.js";

test("normalizeRepoName accepts valid names and rejects bad ones", () => {
  assert.equal(normalizeRepoName("my-project"), "my-project");
  assert.equal(normalizeRepoName("  spaced  "), "spaced");
  assert.throws(() => normalizeRepoName("has space"), RepoError);
  assert.throws(() => normalizeRepoName("-leading"), RepoError);
  assert.throws(() => normalizeRepoName("bad!char"), RepoError);
  assert.throws(() => normalizeRepoName("project.git"), RepoError);
});

test("createRepo creates a bare repo under an owner namespace", async () => {
  const name = uniqueName("repo");
  const repo = await createRepo("alice", name, "a description");
  assert.equal(repo.name, name);
  assert.equal(repo.owner, "alice");
  assert.equal(repo.slug, `alice/${name}`);
  assert.equal(repo.description, "a description");
  assert.equal(repo.empty, true);
  assert.equal(repo.defaultBranch, "main");
});

test("the same name can exist under different owners", async () => {
  const name = uniqueName("shared");
  await createRepo("alice", name);
  await createRepo("bob", name); // must not collide
  assert.ok(await getRepo(`alice/${name}`));
  assert.ok(await getRepo(`bob/${name}`));
});

test("createRepo rejects duplicate names within an owner", async () => {
  const name = uniqueName("repo");
  await createRepo("carol", name);
  await assert.rejects(() => createRepo("carol", name), RepoError);
});

test("getRepo and listRepos resolve by slug", async () => {
  const name = uniqueName("repo");
  assert.equal(await getRepo("nobody/missing-xyz"), null);
  assert.equal(await getRepo("not-a-slug"), null); // needs owner/name
  await createRepo("dave", name);

  const all = await listRepos();
  assert.ok(all.some((r) => r.slug === `dave/${name}`));

  const mine = await listReposByOwner("dave");
  assert.ok(mine.some((r) => r.name === name));
});
