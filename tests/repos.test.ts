import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRepo,
  getRepo,
  listRepos,
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

test("createRepo creates a bare repo with owner and empty state", async () => {
  const name = uniqueName("repo");
  const repo = await createRepo(name, "a description", "owner1");
  assert.equal(repo.name, name);
  assert.equal(repo.description, "a description");
  assert.equal(repo.owner, "owner1");
  assert.equal(repo.empty, true);
  assert.equal(repo.defaultBranch, "main");
});

test("createRepo rejects duplicate names", async () => {
  const name = uniqueName("repo");
  await createRepo(name);
  await assert.rejects(() => createRepo(name), RepoError);
});

test("getRepo returns null for unknown repos and listRepos includes created ones", async () => {
  const name = uniqueName("repo");
  assert.equal(await getRepo("definitely-not-here-xyz"), null);
  await createRepo(name);
  const all = await listRepos();
  assert.ok(all.some((r) => r.name === name));
});
