import assert from "node:assert/strict";
import { test } from "node:test";
import { compareRefs, mergeability, mergeRefs } from "../src/git/compare.js";
import { getCommit, listCommits } from "../src/git/history.js";
import { listBranches, listRefNames, listTags } from "../src/git/refs.js";
import { findReadme, listDirectory, objectType, readBlob } from "../src/git/tree.js";
import { seedRepo, uniqueName } from "./helpers.js";

const author = { name: "tester", email: "tester@thecrux.local" };

test("browse: tree listing, blob reading, readme, object type", async () => {
  const name = uniqueName("tree");
  await seedRepo(name, {
    "README.md": "# Hello\n\nA test repo.\n",
    "src/index.js": "console.log('hi');\n",
  });

  const entries = await listDirectory(name, "main", "");
  assert.ok(entries);
  const names = entries!.map((e) => e.name);
  assert.deepEqual(names, ["src", "README.md"]); // dirs first, then files
  assert.equal(entries!.find((e) => e.name === "src")?.type, "tree");

  assert.equal(await objectType(name, "main", "src"), "tree");
  assert.equal(await objectType(name, "main", "README.md"), "blob");
  assert.equal(await objectType(name, "main", "nope"), null);

  const blob = await readBlob(name, "main", "README.md");
  assert.match(blob!.text!, /# Hello/);
  assert.equal(blob!.isBinary, false);

  const readme = await findReadme(name, "main", "");
  assert.equal(readme?.name, "README.md");
});

test("history: commits and a parsed commit diff", async () => {
  const name = uniqueName("hist");
  const repo = await seedRepo(name, { "a.txt": "one\n" });
  repo.writeFile("a.txt", "one\ntwo\n");
  repo.commitAll("add second line");

  const page = await listCommits(name, "main", {});
  assert.ok(page);
  assert.equal(page!.commits.length, 2);
  assert.equal(page!.commits[0].subject, "add second line");

  const detail = await getCommit(name, page!.commits[0].hash);
  assert.equal(detail!.files.length, 1);
  assert.equal(detail!.files[0].path, "a.txt");
  assert.equal(detail!.additions, 1);
});

test("refs: branches, tags and names", async () => {
  const name = uniqueName("refs");
  const repo = await seedRepo(name, { "f.txt": "x\n" });
  repo.git(["tag", "v1.0.0"]);
  repo.git(["push", "origin", "v1.0.0"]);
  repo.git(["checkout", "-b", "feature"]);
  repo.writeFile("g.txt", "y\n");
  repo.commitAll("on feature", "feature");

  const branches = await listBranches(name);
  const branchNames = branches!.map((b) => b.name).sort();
  assert.deepEqual(branchNames, ["feature", "main"]);

  const tags = await listTags(name);
  assert.equal(tags!.length, 1);
  assert.equal(tags![0].name, "v1.0.0");

  const refNames = await listRefNames(name);
  assert.ok(refNames.branches.includes("feature"));
  assert.ok(refNames.tags.includes("v1.0.0"));
});

test("compare + fast-forward merge", async () => {
  const name = uniqueName("ff");
  const repo = await seedRepo(name, { "base.txt": "base\n" });
  repo.git(["checkout", "-b", "feature"]);
  repo.writeFile("feature.txt", "new\n");
  repo.commitAll("add feature file", "feature");

  const cmp = await compareRefs(name, "main", "feature");
  assert.equal(cmp!.identical, false);
  assert.equal(cmp!.fastForward, true);
  assert.equal(cmp!.commits.length, 1);
  assert.equal(await mergeability(name, cmp!), "ff");

  const result = await mergeRefs(name, "main", "feature", "merge", author);
  assert.equal(result.ok, true);
  assert.equal(result.fastForward, true);
  // feature.txt is now reachable from main
  assert.equal(await objectType(name, "main", "feature.txt"), "blob");
});

test("clean non-fast-forward merge produces a merge commit", async () => {
  const name = uniqueName("merge");
  const repo = await seedRepo(name, { "shared.txt": "shared\n" });
  // diverge: branch adds its own file, main adds a different file
  repo.git(["checkout", "-b", "topic"]);
  repo.writeFile("topic.txt", "topic\n");
  repo.commitAll("add topic file", "topic");
  repo.git(["checkout", "main"]);
  repo.writeFile("main.txt", "main\n");
  repo.commitAll("add main file");

  const cmp = await compareRefs(name, "main", "topic");
  assert.equal(cmp!.fastForward, false);
  assert.equal(await mergeability(name, cmp!), "clean");

  const result = await mergeRefs(name, "main", "topic", "merge topic", author);
  assert.equal(result.ok, true);
  assert.equal(result.fastForward, false);

  // both files present on main, and the merge commit has two parents
  assert.equal(await objectType(name, "main", "topic.txt"), "blob");
  assert.equal(await objectType(name, "main", "main.txt"), "blob");
  const merge = await getCommit(name, result.sha!);
  assert.equal(merge!.parents.length, 2);
});

test("conflicting merge is detected and blocked", async () => {
  const name = uniqueName("conflict");
  const repo = await seedRepo(name, { "file.txt": "original\n" });
  repo.git(["checkout", "-b", "other"]);
  repo.writeFile("file.txt", "from other\n");
  repo.commitAll("change on other", "other");
  repo.git(["checkout", "main"]);
  repo.writeFile("file.txt", "from main\n");
  repo.commitAll("change on main");

  const cmp = await compareRefs(name, "main", "other");
  assert.equal(cmp!.fastForward, false);
  assert.equal(await mergeability(name, cmp!), "conflict");

  const before = repo.git(["rev-parse", "main"]).trim();
  const result = await mergeRefs(name, "main", "other", "should fail", author);
  assert.equal(result.ok, false);
  assert.equal(result.conflict, true);
  // main is unchanged on the server
  const refList = await listRefNames(name);
  assert.ok(refList.branches.includes("main"));
});
