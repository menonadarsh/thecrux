import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Project root (one level up from src/ or dist/). */
export const ROOT = path.resolve(__dirname, "..");

/** Base directory for all persistent data (repos, users, secret). */
const dataDir = process.env.CRUX_DATA_DIR ?? path.join(ROOT, "data");

/**
 * Parse CRUX_TRUST_PROXY into a value Express's "trust proxy" accepts:
 * unset/false -> no proxy; a number -> trust that many hops; otherwise the raw
 * string (e.g. "loopback", a subnet, or "true").
 */
function parseTrustProxy(raw: string | undefined): boolean | number | string {
  if (raw === undefined || raw === "" || raw === "false") return false;
  if (raw === "true") return true;
  const n = Number(raw);
  return Number.isInteger(n) && String(n) === raw ? n : raw;
}

const truthy = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v ?? "");

const host = process.env.HOST ?? "127.0.0.1";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host,

  /** Base data directory. */
  dataDir,

  /** Directory where bare git repositories are stored. */
  reposDir: process.env.CRUX_REPOS_DIR ?? path.join(dataDir, "repos"),

  /**
   * Reverse-proxy trust. Set CRUX_TRUST_PROXY (e.g. "1") when running behind a
   * TLS-terminating proxy so req.protocol/req.secure reflect X-Forwarded-Proto.
   */
  trustProxy: parseTrustProxy(process.env.CRUX_TRUST_PROXY),

  /**
   * Force the Secure flag on the session cookie. Off by default so plain-HTTP
   * intranet deployments still work; the cookie is otherwise marked Secure
   * automatically whenever the request itself is HTTPS.
   */
  forceSecureCookies: truthy(process.env.CRUX_SECURE_COOKIES),

  /**
   * git-over-SSH server. Enabled by default on an unprivileged port so it works
   * in a container without root; the host follows HOST. Set CRUX_SSH_HOST_KEY to
   * a PEM private key path to bring your own host key (stable known_hosts across
   * replicas); otherwise one is generated and persisted under the data dir.
   */
  ssh: {
    enabled: process.env.CRUX_SSH_ENABLED === undefined ? true : truthy(process.env.CRUX_SSH_ENABLED),
    port: Number(process.env.CRUX_SSH_PORT ?? 2222),
    host: process.env.CRUX_SSH_HOST ?? host,
    hostKeyPath: process.env.CRUX_SSH_HOST_KEY,
  },

  /** Public-facing name. */
  appName: "thecrux",
};
