import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * After a push, a freshly-created bare repo may still have HEAD pointing at an
 * unborn branch (e.g. it was init'd as `main` but the client pushed `master`).
 * Repoint HEAD at a real branch so the repo no longer looks empty.
 */
export async function repairHead(dir: string): Promise<void> {
  try {
    const head = (await execFileAsync("git", ["-C", dir, "symbolic-ref", "HEAD"])).stdout.trim();
    const branch = head.replace(/^refs\/heads\//, "");
    await execFileAsync("git", ["-C", dir, "rev-parse", "--verify", branch]);
    return; // HEAD already resolves — nothing to do.
  } catch {
    // HEAD is unborn; fall through and pick an existing branch.
  }

  try {
    const out = (
      await execFileAsync("git", ["-C", dir, "for-each-ref", "--format=%(refname:short)", "refs/heads"])
    ).stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (out.length === 0) return;
    const preferred = out.find((b) => b === "main") ?? out.find((b) => b === "master") ?? out[0];
    await execFileAsync("git", ["-C", dir, "symbolic-ref", "HEAD", `refs/heads/${preferred}`]);
  } catch (err) {
    console.error("repairHead failed:", err);
  }
}

/**
 * Run after a `receive-pack` completes (HTTP or SSH): refresh dumb-HTTP info and
 * make sure HEAD points at a real branch. Shared by both git transports.
 */
export function finishReceivePack(dir: string): void {
  execFile("git", ["-C", dir, "update-server-info"], () => {});
  void repairHead(dir);
}
