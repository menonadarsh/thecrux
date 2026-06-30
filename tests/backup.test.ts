import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createBackup, restoreBackup } from "../src/backup.js";

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Populate a fake data dir with the kinds of files thecrux stores. */
function seedDataDir(): string {
  const dir = tmpdir("cruxdata-");
  fs.writeFileSync(path.join(dir, "users.json"), '{"ada":{"username":"ada"}}');
  fs.writeFileSync(path.join(dir, "secret"), "s3cret");
  const repo = path.join(dir, "ada", "proj.git");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "crux-owner"), "ada\n");
  fs.writeFileSync(path.join(repo, "HEAD"), "ref: refs/heads/main\n");
  return dir;
}

test("backup then restore round-trips the data dir", async () => {
  const data = seedDataDir();
  const out = tmpdir("cruxout-");

  const archive = await createBackup({ dataDir: data, outDir: out });
  assert.ok(fs.existsSync(archive), "archive should exist");
  assert.match(path.basename(archive), /^thecrux-backup-.*\.tar\.gz$/);

  // Restore into a fresh, empty data dir.
  const restored = tmpdir("cruxrestore-");
  fs.rmSync(restored, { recursive: true, force: true }); // make it not-exist
  await restoreBackup(archive, { dataDir: restored });

  assert.equal(fs.readFileSync(path.join(restored, "users.json"), "utf8"), '{"ada":{"username":"ada"}}');
  assert.equal(fs.readFileSync(path.join(restored, "secret"), "utf8"), "s3cret");
  assert.equal(fs.readFileSync(path.join(restored, "ada", "proj.git", "crux-owner"), "utf8"), "ada\n");
});

test("restore refuses to overwrite a non-empty data dir without --force", async () => {
  const data = seedDataDir();
  const out = tmpdir("cruxout-");
  const archive = await createBackup({ dataDir: data, outDir: out });

  const target = tmpdir("cruxtarget-");
  fs.writeFileSync(path.join(target, "keep.txt"), "precious");

  await assert.rejects(() => restoreBackup(archive, { dataDir: target }), /not empty/i);

  // With --force it proceeds and lays the backup down over the target.
  await restoreBackup(archive, { dataDir: target, force: true });
  assert.ok(fs.existsSync(path.join(target, "users.json")));
});

test("backup of a missing data dir fails clearly", async () => {
  const missing = path.join(os.tmpdir(), "cruxnope-" + Date.now());
  await assert.rejects(() => createBackup({ dataDir: missing, outDir: tmpdir("o-") }));
});
