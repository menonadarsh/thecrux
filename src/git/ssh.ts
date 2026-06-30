import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ssh2, { type Server as SshServer } from "ssh2";
import { canRead, canWrite, isArchived } from "../auth/access.js";
import { findUserBySshKey } from "../auth/users.js";
import { config } from "../config.js";
import { parseRepoRef, repoDir } from "./exec.js";
import { finishReceivePack, snapshotRefs, type PushContext } from "./transport.js";

const { Server, utils } = ssh2;

/** OpenSSH-style "SHA256:…" fingerprint of a public-key blob. */
function fingerprintOf(blob: Buffer): string {
  return "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
}

/**
 * Load the SSH host key: an explicit CRUX_SSH_HOST_KEY path (bring-your-own, so
 * known_hosts stays stable across replicas) wins; otherwise read or generate +
 * persist one under the data dir. ssh2 parses RSA (PKCS#1) and OpenSSH formats,
 * so the auto-generated default is RSA-3072; a BYO key may be any of those.
 */
function loadHostKey(): string {
  const file = config.ssh.hostKeyPath ?? path.join(config.dataDir, "ssh_host_key");
  try {
    const existing = fs.readFileSync(file, "utf8");
    if (existing.includes("PRIVATE KEY")) return existing;
  } catch {
    // not yet created
  }
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file, privateKey, { mode: 0o600 });
  } catch {
    // fall back to an in-memory host key (known_hosts will churn on restart)
  }
  return privateKey;
}

let cachedHostKey: string | null = null;
function hostKey(): string {
  return (cachedHostKey ??= loadHostKey());
}

/** The host key's fingerprint, for users to verify their known_hosts entry. */
export function sshHostFingerprint(): string {
  const parsed = utils.parseKey(hostKey());
  if (parsed instanceof Error) return "";
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  return fingerprintOf(key.getPublicSSH());
}

/** Parse a git SSH exec command into its service and "owner/repo" slug. */
function parseGitExec(command: string): { service: string; slug: string } | null {
  const m = /^(git-upload-pack|git-receive-pack|git-upload-archive) (.+)$/.exec(command.trim());
  if (!m) return null;
  const slug = m[2]
    .trim()
    .replace(/^['"]|['"]$/g, "") // strip surrounding quotes git adds
    .replace(/^\/+/, "") // tolerate a leading slash
    .replace(/\.git$/, "");
  return { service: m[1], slug };
}

/**
 * Start the in-process git-over-SSH server. Public-key auth only; the presented
 * key's fingerprint maps to an account, and repo access is enforced with the
 * same canRead/canWrite the HTTP transport uses. Returns the server so the
 * caller can close it on shutdown.
 */
export function startSshServer(opts: { port?: number; host?: string } = {}): SshServer {
  const port = opts.port ?? config.ssh.port;
  const host = opts.host ?? config.ssh.host;
  const server = new Server({ hostKeys: [hostKey()] }, (client) => {
    let username: string | null = null;

    client.on("authentication", (ctx) => {
      if (ctx.method !== "publickey") {
        ctx.reject(["publickey"]);
        return;
      }
      const fingerprint = fingerprintOf(ctx.key.data);
      const user = findUserBySshKey(fingerprint);
      if (!user) {
        ctx.reject();
        return;
      }
      // When the client sends a signature, verify it against the stored key.
      if (ctx.signature) {
        const stored = user.sshKeys?.find((k) => k.fingerprint === fingerprint);
        const parsed = stored ? utils.parseKey(stored.publicKey) : null;
        const key = Array.isArray(parsed) ? parsed[0] : parsed;
        if (!key || key instanceof Error || key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) {
          ctx.reject();
          return;
        }
      }
      username = user.username;
      ctx.accept();
    });

    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        const session = acceptSession();
        session.on("exec", (acceptExec, _rejectExec, info) => {
          const channel = acceptExec();
          void runGit(info.command, username, channel).catch(() => channel.end());
        });
        // No interactive shell or other subsystems — git only.
        session.on("shell", (_accept, reject) => reject());
      });
    });

    // Swallow protocol errors (port scanners, aborted handshakes) so they don't
    // crash the process.
    client.on("error", () => {});
  });

  server.on("error", (err: Error) => console.error("SSH server error:", err));
  server.listen(port, host, () => {
    console.log(`SSH git transport on ${host}:${port}`);
  });
  return server;
}

/** Authorize and run a git service for an authenticated user over an SSH channel. */
async function runGit(command: string, username: string | null, channel: ssh2.ServerChannel): Promise<void> {
  const fail = (message: string, code = 1) => {
    channel.stderr.write(`thecrux: ${message}\n`);
    channel.exit(code);
    channel.end();
  };

  const parsed = parseGitExec(command);
  if (!parsed) return fail("only git operations are supported over SSH");

  const isWrite = parsed.service === "git-receive-pack";
  const dir = parseRepoRef(parsed.slug) ? repoDir(parsed.slug) : null;
  const exists = dir ? fs.existsSync(dir) : false;

  // Read access is required to even reveal the repo; otherwise look like 404.
  if (!dir || !exists || !canRead(parsed.slug, username)) {
    return fail("repository not found");
  }
  if (isWrite && !canWrite(parsed.slug, username)) {
    return fail("you do not have write access to this repository");
  }
  if (isWrite && isArchived(parsed.slug)) {
    return fail("this repository is archived (read-only)");
  }

  // Capture refs up front so webhooks can report what the push changed.
  const ctx: PushContext | undefined = isWrite
    ? { slug: parsed.slug, pusher: username, before: await snapshotRefs(dir) }
    : undefined;

  const subcommand = parsed.service.replace(/^git-/, "");
  const child = spawn("git", [subcommand, dir]);
  channel.pipe(child.stdin);
  // Don't let pipe() auto-close the channel: the SSH *exit status* must be sent
  // before the channel closes, or git treats an otherwise-successful operation
  // as failed. We close explicitly once the process exits.
  child.stdout.pipe(channel, { end: false });
  child.stderr.pipe(channel.stderr, { end: false });
  child.on("error", () => fail("git failed to start"));
  child.on("close", (code) => {
    if (isWrite) finishReceivePack(dir, ctx);
    channel.exit(code ?? 0);
    channel.end();
  });
}
