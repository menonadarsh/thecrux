import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDiff } from "../src/git/history.js";

test("parseDiff: modified file counts adds and dels", () => {
  const patch = [
    "diff --git a/file.txt b/file.txt",
    "index 1111111..2222222 100644",
    "--- a/file.txt",
    "+++ b/file.txt",
    "@@ -1,3 +1,3 @@",
    " line1",
    "-line2",
    "+line2 changed",
    " line3",
  ].join("\n");
  const files = parseDiff(patch);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "file.txt");
  assert.equal(files[0].status, "modified");
  assert.equal(files[0].additions, 1);
  assert.equal(files[0].deletions, 1);
});

test("parseDiff: added file", () => {
  const patch = [
    "diff --git a/new.txt b/new.txt",
    "new file mode 100644",
    "index 0000000..3333333",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1,2 @@",
    "+hello",
    "+world",
  ].join("\n");
  const [f] = parseDiff(patch);
  assert.equal(f.status, "added");
  assert.equal(f.additions, 2);
  assert.equal(f.deletions, 0);
});

test("parseDiff: deleted file", () => {
  const patch = [
    "diff --git a/old.txt b/old.txt",
    "deleted file mode 100644",
    "index 4444444..0000000",
    "--- a/old.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
  ].join("\n");
  const [f] = parseDiff(patch);
  assert.equal(f.status, "deleted");
  assert.equal(f.deletions, 1);
});

test("parseDiff: renamed file", () => {
  const patch = [
    "diff --git a/old.txt b/new.txt",
    "similarity index 100%",
    "rename from old.txt",
    "rename to new.txt",
  ].join("\n");
  const [f] = parseDiff(patch);
  assert.equal(f.status, "renamed");
  assert.equal(f.oldPath, "old.txt");
  assert.equal(f.path, "new.txt");
});

test("parseDiff: binary file", () => {
  const patch = [
    "diff --git a/img.png b/img.png",
    "new file mode 100644",
    "index 0000000..5555555",
    "Binary files /dev/null and b/img.png differ",
  ].join("\n");
  const [f] = parseDiff(patch);
  assert.equal(f.binary, true);
});

test("parseDiff: multiple files in one patch", () => {
  const patch = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1 +1 @@",
    "-a",
    "+A",
    "diff --git a/b.txt b/b.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/b.txt",
    "@@ -0,0 +1 @@",
    "+b",
  ].join("\n");
  const files = parseDiff(patch);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, "a.txt");
  assert.equal(files[1].path, "b.txt");
  assert.equal(files[1].status, "added");
});

test("parseDiff: line numbers track old/new", () => {
  const patch = [
    "diff --git a/f b/f",
    "--- a/f",
    "+++ b/f",
    "@@ -1,2 +1,2 @@",
    " keep",
    "-gone",
    "+added",
  ].join("\n");
  const [f] = parseDiff(patch);
  const ctx = f.lines.find((l) => l.kind === "ctx");
  const del = f.lines.find((l) => l.kind === "del");
  const add = f.lines.find((l) => l.kind === "add");
  assert.equal(ctx?.oldNo, 1);
  assert.equal(ctx?.newNo, 1);
  assert.equal(del?.oldNo, 2);
  assert.equal(del?.newNo, null);
  assert.equal(add?.newNo, 2);
  assert.equal(add?.oldNo, null);
});
