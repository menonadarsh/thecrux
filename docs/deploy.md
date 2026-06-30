# Deploying thecrux

thecrux is a single Node app that stores everything on disk under one data dir —
bare git repos, users, settings, the session secret and the SSH host key. There
is no database. That keeps deployment, backups and moving hosts simple. For the
architecture behind that, see [`design.md`](design.md).

thecrux is open source (MIT) and distributed freely — there is no product
account or download gate. Get it as a Docker image (the path below) or from
source; the only account you create is the admin account on your own instance,
on first run.

The same image serves two shapes of deployment:

- **Turnkey** (startup / individual): one container, sane defaults, a reverse
  proxy in front for TLS. Up in minutes.
- **Self-managed** (org with IT): the same image, tuned by configuration — bind
  addresses, your own host key, registration locked down, your own backup and
  TLS pipeline. No forks, no separate "enterprise" build.

## Requirements

- Node.js ≥ 20 and `git` on the host, **or** Docker.
- `tar` (for `crux backup`/`restore`) — present on every standard host and in
  the container image.

## Quick start (Docker Compose)

```bash
cp .env.example .env          # set CRUX_SECRET, review the rest
docker compose up -d --build
```

This binds HTTP on `3000` and SSH on `2222`, persisting `/data` in a named
volume. Put a TLS-terminating reverse proxy in front (below).

## Reverse proxy + TLS

Terminate HTTPS at a proxy and set `CRUX_TRUST_PROXY=1` so the app sees the real
scheme (and marks the session cookie `Secure`). Caddy gives you automatic certs:

```caddyfile
git.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

```bash
# in .env
CRUX_TRUST_PROXY=1
HOST=0.0.0.0
```

For SSH, either tell users the port (`ssh://git@git.example.com:2222/...`) or map
host `22` to the container's `2222` in `docker-compose.yml` (`"22:2222"`) so bare
`git@git.example.com:owner/repo.git` works.

### On a bare IP / without a domain

thecrux speaks plain HTTP and never terminates TLS itself — a reverse proxy in
front does. To reach it directly by IP, bind it to all interfaces:

```bash
# in .env
HOST=0.0.0.0
CRUX_TRUST_PROXY=1   # so the app sees HTTPS from the proxy and marks cookies Secure
```

You *can* run it as plain `http://<ip>:3000` with no proxy, but the session
cookie won't be `Secure` and credentials/clones travel in clear text — only
acceptable on a trusted private network. For HTTPS the snag is the certificate,
not thecrux: **public CAs (incl. the Let's Encrypt issuer Caddy uses by default)
won't issue certs for a bare IP address.** Three ways around it:

- **Give it a hostname (recommended).** Even without buying a domain, a wildcard
  DNS service like [`sslip.io`](https://sslip.io) maps an IP into a name —
  `203.0.113.5` → `203-0-113-5.sslip.io` — which Caddy can auto-cert:

  ```caddyfile
  203-0-113-5.sslip.io {
      reverse_proxy 127.0.0.1:3000
  }
  ```

- **Self-signed cert on the IP** — fine for a private/intranet box; clients (and
  `git`) will warn until they trust your CA. With Caddy:

  ```caddyfile
  https://203.0.113.5 {
      tls internal              # Caddy's local CA; install its root on clients
      reverse_proxy 127.0.0.1:3000
  }
  ```

  For `git` over such a cert, either install Caddy's root CA on each client or,
  per-repo only, `git -c http.sslVerify=false clone https://203.0.113.5/...`.

- **An IP certificate** from a CA that issues them (e.g. ZeroSSL) — works, but
  more setup than a hostname.

A hostname is almost always less friction than self-signed certs you have to
distribute, so prefer the `sslip.io`-style option unless you already run an
internal CA.

## Health checks

The app answers `GET /healthz` with `{"status":"ok"}` — cheap, unauthenticated,
and safe to hit from a load balancer or orchestrator liveness/readiness probe.
On `SIGTERM`/`SIGINT` the server drains in-flight HTTP and closes the SSH server
before exiting, so rolling restarts don't cut active clones mid-stream.

## Configuration

All knobs are environment variables — see [`.env.example`](../.env.example) and
the table in the [README](../README.md#configuration). The essentials:

| Variable            | Why you'd set it                                            |
| ------------------- | ---------------------------------------------------------- |
| `CRUX_SECRET`       | Pin session signing across rebuilds / replicas             |
| `CRUX_TRUST_PROXY`  | You run behind a TLS-terminating proxy                     |
| `CRUX_SSH_PORT`     | Change the SSH port (or `CRUX_SSH_ENABLED=0` to disable)   |
| `CRUX_SSH_HOST_KEY` | Bring your own SSH host key (stable `known_hosts`)         |

After the first run, sign up — **the first account becomes the admin**. From the
admin panel (`/admin`) you can set registration to open / invite-only / closed
and manage users.

## Backups

Everything lives under the data dir, so a backup is a snapshot of it. The bundled
CLI writes a timestamped archive:

```bash
# local
npm run crux -- backup --out /var/backups/thecrux

# Docker
docker compose exec thecrux node dist/cli.js backup --out /data/backups
```

A nightly cron is usually enough:

```cron
0 3 * * *  cd /srv/thecrux && /usr/bin/docker compose exec -T thecrux \
           node dist/cli.js backup --out /data/backups
```

> The archive contains the session secret and SSH host key — store it somewhere
> private. For a *guaranteed*-consistent backup of a busy server, snapshot the
> volume (LVM/ZFS/cloud snapshot) or stop the service during the copy; the live
> `crux backup` is consistent for metadata (atomic writes) but could catch a repo
> mid-push.

## Restore

Restore into an empty data dir (it refuses to overwrite a populated one without
`--force`):

```bash
npm run crux -- restore /var/backups/thecrux/thecrux-backup-….tar.gz
# Docker:
docker compose exec thecrux node dist/cli.js restore /data/backups/thecrux-backup-….tar.gz
```

Then start the app and verify you can sign in and clone. Practice this once — an
untested backup isn't a backup.

## Upgrades

Pull the new image and recreate the container; the data dir is untouched:

```bash
docker compose pull && docker compose up -d
```

The app applies any needed on-disk migrations at startup (e.g. the legacy repo
layout move). Back up first.
