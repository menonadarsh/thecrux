import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";

/**
 * Write a file atomically: write to a uniquely-named temp file in the same
 * directory, then rename it over the target. rename(2) is atomic on POSIX, so a
 * concurrent reader — or a crash mid-write — never sees a half-written file.
 * The temp file shares the target's directory so the rename stays on one
 * filesystem (cross-device renames aren't atomic and would fail).
 */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fsp.writeFile(tmp, data, "utf8");
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Atomically write a value as pretty-printed JSON. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(value, null, 2));
}
