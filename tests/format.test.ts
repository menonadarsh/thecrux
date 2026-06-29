import assert from "node:assert/strict";
import { test } from "node:test";
import { encodePath, humanSize, relativeTime } from "../src/util/format.js";

test("humanSize formats byte counts", () => {
  assert.equal(humanSize(0), "0 B");
  assert.equal(humanSize(512), "512 B");
  assert.equal(humanSize(1024), "1.0 KB");
  assert.equal(humanSize(1536), "1.5 KB");
  assert.equal(humanSize(10 * 1024), "10 KB");
  assert.equal(humanSize(1024 * 1024), "1.0 MB");
  assert.equal(humanSize(null), "");
});

test("relativeTime describes the past", () => {
  const now = Date.now();
  assert.equal(relativeTime(new Date(now - 5_000)), "just now");
  assert.equal(relativeTime(new Date(now - 90_000)), "1 minute ago");
  assert.equal(relativeTime(new Date(now - 2 * 3600_000)), "2 hours ago");
  assert.equal(relativeTime(new Date(now - 3 * 86400_000)), "3 days ago");
});

test("encodePath encodes segments but keeps slashes", () => {
  assert.equal(encodePath("src/index.js"), "src/index.js");
  assert.equal(encodePath("a b/c.txt"), "a%20b/c.txt");
  assert.equal(encodePath("dir/with space/file"), "dir/with%20space/file");
  assert.equal(encodePath(""), "");
});
