import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { deliverPush, diffRefs } from "../webhooks.js";

const execFileAsync = promisify(execFile);

/** Context for a receive-pack so webhooks can describe what changed. */
export interface PushContext {
  slug: string;
  pusher: string | null;
  /** Ref → SHA snapshot taken *before* the push was applied. */
  before: Map<string, string>;
}

/** Snapshot every ref to its SHA, e.g. to diff a push. */
export async function snapshotRefs(dir: string): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  try {
    const out = (
      await execFileAsync("git", ["-C", dir, "for-each-ref", "--format=%(objectname) %(refname)"])
    ).stdout;
    for (const line of out.split("\n")) {
      const sp = line.indexOf(" ");
      if (sp > 0) refs.set(line.slice(sp + 1).trim(), line.slice(0, sp).trim());
    }
  } catch {
    // no refs / not a repo
  }
  return refs;
}

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
export function finishReceivePack(dir: string, ctx?: PushContext): void {
  execFile("git", ["-C", dir, "update-server-info"], () => {});
  void repairHead(dir);
  if (ctx) {
    void (async () => {
      const after = await snapshotRefs(dir);
      await deliverPush(ctx.slug, ctx.pusher, diffRefs(ctx.before, after));
    })();
  }
}
