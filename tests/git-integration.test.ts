import assert from "node:assert/strict";
import { test } from "node:test";
import { compareRefs, mergeability, mergeRefs } from "../src/git/compare.js";
import { getCommit, listCommits } from "../src/git/history.js";
import { listBranches, listRefNames, listTags } from "../src/git/refs.js";
import { findReadme, listDirectory, objectType, readBlob } from "../src/git/tree.js";
import { seedRepo, uniqueName } from "./helpers.js";

const author = { name: "tester", email: "tester@thecrux.local" };

test("browse: tree listing, blob reading, readme, object type", async () => {
  const repo = await seedRepo(uniqueName("tree"), {
    "README.md": "# Hello\n\nA test repo.\n",
    "src/index.js": "console.log('hi');\n",
  });
  const slug = repo.slug;

  const entries = await listDirectory(slug, "main", "");
  assert.ok(entries);
  const names = entries!.map((e) => e.name);
  assert.deepEqual(names, ["src", "README.md"]); // dirs first, then files
  assert.equal(entries!.find((e) => e.name === "src")?.type, "tree");

  assert.equal(await objectType(slug, "main", "src"), "tree");
  assert.equal(await objectType(slug, "main", "README.md"), "blob");
  assert.equal(await objectType(slug, "main", "nope"), null);

  const blob = await readBlob(slug, "main", "README.md");
  assert.match(blob!.text!, /# Hello/);
  assert.equal(blob!.isBinary, false);

  const readme = await findReadme(slug, "main", "");
  assert.equal(readme?.name, "README.md");
});

test("history: commits and a parsed commit diff", async () => {
  const repo = await seedRepo(uniqueName("hist"), { "a.txt": "one\n" });
  repo.writeFile("a.txt", "one\ntwo\n");
  repo.commitAll("add second line");
  const slug = repo.slug;

  const page = await listCommits(slug, "main", {});
  assert.ok(page);
  assert.equal(page!.commits.length, 2);
  assert.equal(page!.commits[0].subject, "add second line");

  const detail = await getCommit(slug, page!.commits[0].hash);
  assert.equal(detail!.files.length, 1);
  assert.equal(detail!.files[0].path, "a.txt");
  assert.equal(detail!.additions, 1);
});

test("refs: branches, tags and names", async () => {
  const repo = await seedRepo(uniqueName("refs"), { "f.txt": "x\n" });
  repo.git(["tag", "v1.0.0"]);
  repo.git(["push", "origin", "v1.0.0"]);
  repo.git(["checkout", "-b", "feature"]);
  repo.writeFile("g.txt", "y\n");
  repo.commitAll("on feature", "feature");
  const slug = repo.slug;

  const branches = await listBranches(slug);
  const branchNames = branches!.map((b) => b.name).sort();
  assert.deepEqual(branchNames, ["feature", "main"]);

  const tags = await listTags(slug);
  assert.equal(tags!.length, 1);
  assert.equal(tags![0].name, "v1.0.0");

  const refNames = await listRefNames(slug);
  assert.ok(refNames.branches.includes("feature"));
  assert.ok(refNames.tags.includes("v1.0.0"));
});

test("compare + fast-forward merge", async () => {
  const repo = await seedRepo(uniqueName("ff"), { "base.txt": "base\n" });
  repo.git(["checkout", "-b", "feature"]);
  repo.writeFile("feature.txt", "new\n");
  repo.commitAll("add feature file", "feature");
  const slug = repo.slug;

  const cmp = await compareRefs(slug, "main", "feature");
  assert.equal(cmp!.identical, false);
  assert.equal(cmp!.fastForward, true);
  assert.equal(cmp!.commits.length, 1);
  assert.equal(await mergeability(slug, cmp!), "ff");

  const result = await mergeRefs(slug, "main", "feature", "merge", author);
  assert.equal(result.ok, true);
  assert.equal(result.fastForward, true);
  assert.equal(await objectType(slug, "main", "feature.txt"), "blob");
});

test("clean non-fast-forward merge produces a merge commit", async () => {
  const repo = await seedRepo(uniqueName("merge"), { "shared.txt": "shared\n" });
  repo.git(["checkout", "-b", "topic"]);
  repo.writeFile("topic.txt", "topic\n");
  repo.commitAll("add topic file", "topic");
  repo.git(["checkout", "main"]);
  repo.writeFile("main.txt", "main\n");
  repo.commitAll("add main file");
  const slug = repo.slug;

  const cmp = await compareRefs(slug, "main", "topic");
  assert.equal(cmp!.fastForward, false);
  assert.equal(await mergeability(slug, cmp!), "clean");

  const result = await mergeRefs(slug, "main", "topic", "merge topic", author);
  assert.equal(result.ok, true);
  assert.equal(result.fastForward, false);

  assert.equal(await objectType(slug, "main", "topic.txt"), "blob");
  assert.equal(await objectType(slug, "main", "main.txt"), "blob");
  const merge = await getCommit(slug, result.sha!);
  assert.equal(merge!.parents.length, 2);
});

test("conflicting merge is detected and blocked", async () => {
  const repo = await seedRepo(uniqueName("conflict"), { "file.txt": "original\n" });
  repo.git(["checkout", "-b", "other"]);
  repo.writeFile("file.txt", "from other\n");
  repo.commitAll("change on other", "other");
  repo.git(["checkout", "main"]);
  repo.writeFile("file.txt", "from main\n");
  repo.commitAll("change on main");
  const slug = repo.slug;

  const cmp = await compareRefs(slug, "main", "other");
  assert.equal(cmp!.fastForward, false);
  assert.equal(await mergeability(slug, cmp!), "conflict");

  const result = await mergeRefs(slug, "main", "other", "should fail", author);
  assert.equal(result.ok, false);
  assert.equal(result.conflict, true);
  const refList = await listRefNames(slug);
  assert.ok(refList.branches.includes("main"));
});
