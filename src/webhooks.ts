import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { repoDir } from "./git/exec.js";
import { writeJsonAtomic } from "./util/atomic.js";

/**
 * Per-repository webhooks. A webhook POSTs a JSON payload to a URL after every
 * push (post-receive). Stored as `crux-webhooks.json` inside the repo dir, like
 * the other repo sidecar files.
 */
export interface Webhook {
  id: string;
  url: string;
  /** Optional shared secret; when set, deliveries carry an HMAC signature. */
  secret?: string;
  createdAt: string;
}

/** A single ref update in a push. before/after are SHAs (zeroes = create/delete). */
export interface RefChange {
  ref: string;
  before: string;
  after: string;
}

export class WebhookError extends Error {}

const ZERO = "0".repeat(40);

function filePath(slug: string): string | null {
  const dir = repoDir(slug);
  return dir ? path.join(dir, "crux-webhooks.json") : null;
}

export function listWebhooks(slug: string): Webhook[] {
  const file = filePath(slug);
  if (!file) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(data) ? (data as Webhook[]) : [];
  } catch {
    return [];
  }
}

async function writeWebhooks(slug: string, hooks: Webhook[]): Promise<void> {
  const file = filePath(slug);
  if (file) await writeJsonAtomic(file, hooks);
}

/** Add a webhook. Validates the URL is http(s). Throws WebhookError otherwise. */
export async function addWebhook(slug: string, url: string, secret?: string): Promise<Webhook> {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new WebhookError("Enter a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WebhookError("Webhook URLs must be http or https.");
  }
  const hook: Webhook = {
    id: randomBytes(8).toString("hex"),
    url: parsed.toString(),
    secret: secret?.trim() || undefined,
    createdAt: new Date().toISOString(),
  };
  const hooks = listWebhooks(slug);
  hooks.push(hook);
  await writeWebhooks(slug, hooks);
  return hook;
}

/** Remove a webhook by id. */
export async function removeWebhook(slug: string, id: string): Promise<void> {
  await writeWebhooks(
    slug,
    listWebhooks(slug).filter((h) => h.id !== id),
  );
}

/** Compute the set of changed refs between two ref snapshots. */
export function diffRefs(before: Map<string, string>, after: Map<string, string>): RefChange[] {
  const changes: RefChange[] = [];
  for (const ref of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(ref) ?? ZERO;
    const a = after.get(ref) ?? ZERO;
    if (b !== a) changes.push({ ref, before: b, after: a });
  }
  return changes;
}

/** Build the JSON push payload sent to webhooks. */
export function pushPayload(slug: string, pusher: string | null, changes: RefChange[]) {
  const [owner, name] = slug.split("/");
  return {
    event: "push" as const,
    repository: { slug, owner, name },
    pusher,
    changes,
    timestamp: new Date().toISOString(),
  };
}

async function post(hook: Webhook, body: string): Promise<void> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "thecrux-webhook",
    "x-crux-event": "push",
  };
  if (hook.secret) {
    headers["x-crux-signature"] =
      "sha256=" + createHmac("sha256", hook.secret).update(body).digest("hex");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(hook.url, { method: "POST", headers, body, signal: controller.signal });
  } catch {
    // Best-effort: a down or slow endpoint must not affect the push.
  } finally {
    clearTimeout(timer);
  }
}

/** Deliver a push event to every webhook configured on the repo. */
export async function deliverPush(
  slug: string,
  pusher: string | null,
  changes: RefChange[],
): Promise<void> {
  const hooks = listWebhooks(slug);
  if (hooks.length === 0 || changes.length === 0) return;
  const body = JSON.stringify(pushPayload(slug, pusher, changes));
  await Promise.all(hooks.map((h) => post(h, body)));
}
