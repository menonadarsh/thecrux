import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);

/**
 * Back up the entire data dir — bare repos (with their crux-* sidecar files),
 * users, instance settings, the session secret and the SSH host key — into a
 * single timestamped `.tar.gz`. The archive is built in a temp dir first so an
 * outDir inside the data dir can't make tar recurse into its own output.
 *
 * Returns the path to the written archive. For a guaranteed-consistent backup
 * of a busy instance, snapshot the volume or stop the service first; atomic
 * JSON writes keep metadata sound, but a repo mid-push could still be captured
 * partway.
 */
export async function createBackup(
  opts: { dataDir?: string; outDir?: string } = {},
): Promise<string> {
  const dataDir = opts.dataDir ?? config.dataDir;
  const outDir = opts.outDir ?? process.cwd();
  await fsp.access(dataDir); // throws a clear error if the data dir is missing

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `thecrux-backup-${stamp}.tar.gz`;
  const tmp = path.join(os.tmpdir(), name);

  await execFileAsync("tar", ["-czf", tmp, "-C", dataDir, "."]);

  await fsp.mkdir(outDir, { recursive: true });
  const dest = path.join(outDir, name);
  try {
    await fsp.rename(tmp, dest);
  } catch {
    // rename fails across filesystems — fall back to copy + unlink.
    await fsp.copyFile(tmp, dest);
    await fsp.rm(tmp, { force: true });
  }
  return dest;
}

/**
 * Restore a backup archive into the data dir. Refuses to overwrite a non-empty
 * data dir unless `force` is set, so you can't clobber a live instance by
 * accident.
 */
export async function restoreBackup(
  archive: string,
  opts: { dataDir?: string; force?: boolean } = {},
): Promise<void> {
  const dataDir = opts.dataDir ?? config.dataDir;
  await fsp.access(archive); // throws if the archive is missing

  let existing: string[] = [];
  try {
    existing = await fsp.readdir(dataDir);
  } catch {
    // data dir doesn't exist yet — that's fine, we'll create it.
  }
  if (existing.length > 0 && !opts.force) {
    throw new Error(
      `Data dir ${dataDir} is not empty — refusing to overwrite. Re-run with --force to replace it.`,
    );
  }

  await fsp.mkdir(dataDir, { recursive: true });
  await execFileAsync("tar", ["-xzf", archive, "-C", dataDir]);
}
