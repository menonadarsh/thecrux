import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

/**
 * A single audit-log entry. The log is an append-only JSON-lines file under the
 * data dir — security-relevant events (auth, access changes, admin actions,
 * credential changes). Append-only so it travels with the normal data backup.
 */
export interface AuditEvent {
  /** ISO timestamp. */
  ts: string;
  /** Dotted action, e.g. "login.success", "repo.visibility". */
  action: string;
  /** Who did it (username), or null for anonymous/failed attempts. */
  actor: string | null;
  /** What it acted on — a repo slug, username, token name, etc. */
  target?: string;
  /** Client IP, when known. */
  ip?: string;
  /** Short human-readable note. */
  detail?: string;
}

/** Minimal request shape needed to attribute an event (satisfied by express.Request). */
interface ReqLike {
  currentUser?: { username: string } | null;
  ip?: string;
}

const FILE = path.join(config.dataDir, "audit.log");

async function appendLine(line: string): Promise<void> {
  try {
    await fsp.appendFile(FILE, line, "utf8");
  } catch {
    // Data dir may not exist yet (e.g. very first event) — create it and retry.
    try {
      await fsp.mkdir(config.dataDir, { recursive: true });
      await fsp.appendFile(FILE, line, "utf8");
    } catch {
      // Auditing must never break the request it's recording.
    }
  }
}

/**
 * Record an event. Callers fire-and-forget (failures are swallowed); the
 * returned promise resolves once the line is written, which tests can await.
 */
export function record(entry: Omit<AuditEvent, "ts">): Promise<void> {
  const event: AuditEvent = { ts: new Date().toISOString(), ...entry };
  return appendLine(JSON.stringify(event) + "\n");
}

/** Record an event attributed to the current request (actor + IP filled in). */
export function recordReq(
  req: ReqLike,
  action: string,
  fields: { target?: string; detail?: string } = {},
): Promise<void> {
  return record({ action, actor: req.currentUser?.username ?? null, ip: req.ip, ...fields });
}

export interface AuditQuery {
  limit?: number;
  offset?: number;
  /** Case-insensitive exact actor match. */
  actor?: string;
  /** Case-insensitive substring match on the action. */
  action?: string;
}

export interface AuditPage {
  events: AuditEvent[];
  /** Total matching the filter (for pagination). */
  total: number;
}

/**
 * Read recent events, newest first, with optional filtering and pagination.
 * Reads the whole file (fine at self-hosted scale); malformed lines are skipped.
 */
export async function readRecent(query: AuditQuery = {}): Promise<AuditPage> {
  const { limit = 100, offset = 0, actor, action } = query;
  let raw: string;
  try {
    raw = await fsp.readFile(FILE, "utf8");
  } catch {
    return { events: [], total: 0 };
  }

  const events: AuditEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as AuditEvent);
    } catch {
      // skip a corrupt line
    }
  }
  events.reverse(); // newest first

  const actorLc = actor?.toLowerCase();
  const actionLc = action?.toLowerCase();
  const filtered = events.filter(
    (e) =>
      (!actorLc || (e.actor ?? "").toLowerCase() === actorLc) &&
      (!actionLc || e.action.toLowerCase().includes(actionLc)),
  );

  return { events: filtered.slice(offset, offset + limit), total: filtered.length };
}
