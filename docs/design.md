# thecrux — design

This is the architecture/design reference for thecrux: what it is, the
principles it's built on, how the pieces fit, and where the boundaries are. For
running it in production see [`deploy.md`](deploy.md); for a feature tour see the
[README](../README.md).

## What it is

thecrux is a **self-hosted git server** — a private home for your code with a
keyboard-first web UI, issues and pull requests. It is a single Node.js process
that shells out to the system `git` and stores everything on disk. There is no
database and no external service dependency.

It is meant to be deployed by the people who use it, on hardware they control.
Your code never leaves your server; the project ships no telemetry.

## Design principles

1. **Real bare git repositories, always.** Each repo is a genuine
   `git init --bare` directory. thecrux serves and manipulates them with stock
   `git` plumbing, never a reimplementation. The upshot: full interoperability
   with every git client from day one, and your data is never trapped — a repo
   dir is a repo.
2. **No database.** All state lives as files under one data directory: bare
   repos, users, org membership, instance settings, the session secret, the SSH
   host key, the audit log. This makes backup a `tar` of a directory, makes
   "move to a new host" a copy, and removes a whole class of operational
   surface (migrations, connection pools, a second daemon to run and secure).
3. **One image, two deployment shapes.** The same artifact serves a turnkey
   individual deployment and a configuration-tuned org deployment. There is no
   separate "enterprise" build or fork — differences are environment variables.
   See [Deployment shapes](#deployment-shapes).
4. **Private by default.** A new repo is private: visible and cloneable only by
   its owner and collaborators. Going public is an explicit choice.
5. **Keyboard-first, server-rendered.** Pages are server-rendered EJS with
   progressive enhancement (a command palette, vim-style navigation, theme
   switching) layered on top. No SPA, no build step for the UI, works without
   JavaScript for the core flows.
6. **Atomic, crash-safe writes.** Metadata is written via a write-temp-then-
   rename helper so a crash mid-write can't corrupt a JSON file. Markers are
   single files whose mere existence is the state.

## High-level architecture

```
                         ┌──────────────────────────────────────────┐
   git client  ──HTTP──▶ │  Express app (src/app.ts)                 │
   (clone/push)          │                                           │
                         │  • Smart-HTTP git transport  (git/http)   │ ──▶ git
   browser     ──HTTP──▶ │  • web UI routers (routes/*)              │     plumbing
                         │  • auth: sessions, basic-auth, guards     │       │
   git client  ──SSH───▶ │  ──────────────────────────────────────  │       ▼
   (clone/push)          │  SSH server (git/ssh.ts) ─────────────────┼──▶  bare repos
                         └──────────────────────────────────────────┘    + sidecar files
                                          │                              under  data/
                                          ▼
                              data dir (the single source of truth)
```

Two front doors (HTTP on `:3000`, SSH on `:2222`), one process, one data dir.
Both transports authenticate against the same user store and the same per-repo
access rules, then hand the actual object transfer to `git`.

### Layout

| Path | Responsibility |
| --- | --- |
| `src/server.ts` | Process entry: ensure data dir, run migrations, start HTTP + SSH, graceful shutdown. |
| `src/app.ts` | Express wiring: security headers, `/healthz`, transport mount, body parsing, user loading, routers. |
| `src/config.ts` | Environment → typed `config` object. The only place env vars are read. |
| `src/git/` | Everything git: repo lifecycle, tree/blob browsing, history, refs, compare, the Smart-HTTP and SSH transports. |
| `src/auth/` | Users, sessions, access tokens, SSH keys, per-repo access control, orgs, instance/registration policy, request guards. |
| `src/routes/` | Web UI routers: repos, issues, pulls, account, admin, orgs, auth. |
| `src/issues/`, `src/pulls/` | Issue and pull-request stores (per-repo JSON sidecars). |
| `src/render/` | Markdown rendering (sanitized) and syntax highlighting. |
| `src/webhooks.ts`, `src/audit.ts` | Post-receive webhooks; append-only security audit log. |
| `src/views/` | Server-rendered EJS templates. |
| `public/` | Static assets (the client-side palette/nav script, stylesheet). |

## Data model — everything is files

There is no schema and no migration tool beyond the on-disk reshapes the app
applies at startup. State is laid out like this under the data dir
(`CRUX_DATA_DIR`, default `./data`):

```
data/
├─ repos/
│  └─ <owner>/<name>.git/          # a real bare git repo
│     ├─ (standard git internals: objects/, refs/, config, …)
│     ├─ crux-owner                # the owner namespace (marker/value file)
│     ├─ crux-private              # presence ⇒ repo is private
│     ├─ crux-archived             # presence ⇒ repo is read-only
│     ├─ crux-collaborators.json   # usernames with write access
│     ├─ crux-webhooks.json        # post-receive webhook endpoints
│     ├─ crux-issues.json          # issue tracker
│     └─ crux-pulls.json           # pull requests
├─ users.json                      # accounts: password hash, tokens, ssh keys, admin flag
├─ orgs.json                       # organizations and their member→role maps
├─ instance.json                   # registration policy + invite tokens
├─ audit.log                       # append-only JSON-lines security log
├─ secret                          # session signing key (generated if unset)
└─ ssh_host_key                    # SSH host key (generated if unset)
```

Two deliberate consequences of co-locating repo metadata **inside the repo
directory** as `crux-*` sidecar files:

- A repo is self-contained. Move/copy/back up the `.git` directory and its
  issues, PRs, collaborators, visibility and webhooks travel with it.
- The sidecars are namespaced (`crux-` prefix) so they never collide with git's
  own files and a stock `git` ignores them entirely.

Instance-level state (`users.json`, `orgs.json`, `instance.json`) sits at the
data-dir root. These small JSON files are read into memory and written back
atomically; some are cached in-process for the lifetime of the run.

## Namespacing

Every repo lives under an **owner** namespace: the URL is `/:owner/:repo`, the
git remote is `/:owner/:repo.git`, and on disk it's
`data/repos/<owner>/<name>.git`. An owner is either a **user** (personal
namespace) or an **organization** (shared namespace). Users and orgs share one
global namespace — no user and org may take the same name — and a set of
reserved names (`login`, `register`, `admin`, `healthz`, …) are kept out of it
so they can never shadow a route.

Repos created before namespacing existed are migrated into a `legacy/`
namespace automatically at startup (`migrateFlatRepos`).

## Git transports

A clone or push can arrive two ways; both end in the same place — stock `git`
plumbing operating on the bare repo — after the same auth and access checks.

### Smart-HTTP (`src/git/http.ts`)

Implements git's Smart-HTTP protocol (`/:owner/:repo.git/info/refs` +
`git-upload-pack` / `git-receive-pack`). It is mounted **before** the body
parser in `app.ts` because the transport must read the raw request stream.

- **Clone/fetch** (`upload-pack`) is anonymous for public repos; for private
  repos it requires read access.
- **Push** (`receive-pack`) always requires write access. Credentials come in
  via HTTP Basic — username plus either the account password or, preferred, a
  **personal access token** (`crux_pat_…`). Tokens are stored as SHA-256 hashes;
  the secret is shown once at creation. A push to an archived repo is refused.

Auth failures are an HTTP `401` (no/invalid credentials) or `403`
(authenticated but lacking write access).

### SSH (`src/git/ssh.ts`)

A built-in SSH server (via `ssh2`), on by default on an unprivileged port
(`2222`) so it runs in a container without root. Users add a public key on their
account page; the key fingerprint is the lookup into the user store. The server
authenticates the key, resolves the repo from the command, applies the same
read/write checks, and execs `git-upload-pack` / `git-receive-pack`.

Bring your own host key (`CRUX_SSH_HOST_KEY`) to keep `known_hosts` stable
across rebuilds/replicas; otherwise one is generated and persisted.

## Authentication & access control

**Authentication** (who you are) has three forms, all resolving to a user:

- **Session cookie** for the web UI — a signed cookie (`src/auth/session.ts`)
  keyed by the data-dir `secret`. Passwords are hashed with `scrypt`.
- **Personal access token** for git-over-HTTP push.
- **SSH public key** for git-over-SSH.

**Authorization** (what you may do) is per-repo and computed in
`src/auth/access.ts`:

- The repo **owner** has admin rights. For a personal namespace that's the
  matching user; for an org namespace it's any **org owner**.
- **Collaborators** listed on the repo have write access; for an org namespace,
  any **org member** can write to every repo in the org.
- **Read** is unrestricted for public repos; for private repos it's limited to
  anyone who can write.

So the model composes cleanly: `canRead` ⊇ `canWrite` ⊇ `isOwner`, and org
membership is folded in at the `isOwner`/`canWrite` layer rather than special-
cased per route. Write actions — push, merging PRs, closing/reopening issues &
PRs — go through these checks; an author may always close/reopen their own item.

**Instance policy** (`src/auth/instance.ts`) gates account creation: `open`,
`invite` (single-use tokens), or `closed`. The **first** account created on a
fresh instance always succeeds and is made **admin**; the admin panel
(`/admin`) sets the policy, issues invites, and manages users.

## Request lifecycle (web)

1. Security headers (`nosniff`, `DENY` framing, `no-referrer`) on every
   response; `/healthz` is answered early and unauthenticated.
2. The Smart-HTTP git router gets first crack (raw stream).
3. Body parsing and static assets.
4. `loadUser` resolves the session cookie to a user for the rest of the
   request.
5. View locals are populated (app name, formatting helpers, `canRegister`,
   `repoBase`).
6. Feature routers handle the route; a `404` and a `500` error view close it
   out.

## Subsystems

- **Browsing & history** (`src/git/tree.ts`, `history.ts`, `refs.ts`,
  `compare.ts`) read the bare repo via git plumbing: tree/blob views, raw files,
  commit log, per-commit and ref-to-ref diffs, branches and tags.
- **Issues & pull requests** (`src/issues/`, `src/pulls/`) share one comment-
  thread model. A PR compares a head ref into a base ref; merges are performed
  server-side directly on the bare repo — fast-forward when possible, otherwise
  a real two-parent merge commit via `git merge-tree` + `commit-tree`, with
  conflict detection that blocks an unmergeable PR.
- **Rendering** (`src/render/`) turns markdown into sanitized HTML and applies
  theme-aware syntax highlighting.
- **Webhooks** (`src/webhooks.ts`) fire a JSON POST after each push
  (post-receive), with an optional HMAC signature derived from a per-hook
  secret.
- **Audit log** (`src/audit.ts`) appends a JSON line for every security-relevant
  event (auth, access changes, admin actions, credential changes). Append-only
  and under the data dir, so it rides along with the normal backup.
- **Backup/restore** (`src/cli.ts`) snapshots and restores the whole data dir as
  a timestamped `.tar.gz`.

## Deployment shapes

One image, tuned by configuration (see [`deploy.md`](deploy.md) for the full
guide and the env-var table):

- **Turnkey** (startup / individual): one container, defaults intact, a
  TLS-terminating reverse proxy in front. The SSH server and sane ports come
  for free. Up in minutes.
- **Self-managed** (org with IT): the same image with registration locked down,
  your own SSH host key, bind addresses tuned, and your own TLS/backup
  pipelines. No fork, no separate build.

`/healthz` gives orchestrators a cheap liveness probe. Graceful shutdown drains
in-flight HTTP and closes the SSH server on `SIGTERM`/`SIGINT`.

## Distribution & product model

thecrux is **open-source (MIT), self-hosted software, distributed freely**.
Obtaining it requires **no product-level account** — there is no central
`thecrux.com` registration gate, no emailed download link, no license server.
The only account anyone ever creates is on **their own running instance**, after
they deploy it (the first such account becomes that instance's admin).

This is a deliberate strategic choice, and the right one for an MIT self-hosted
tool: gating a free download behind registration is friction that suppresses
adoption and contradicts the product's core promise ("your code never leaves
your server"). It matches how the comparable self-hosted git servers
distribute.

**Channels** (in priority order):

1. **Docker** — the headline path. `docker run` / Compose, no host
   dependencies beyond Docker. This is what "get started" points at.
2. **From source** — clone the repo, `npm install`, `npm run build`, `npm start`
   (needs Node ≥ 20 and `git` on the host).
3. *(future)* prebuilt release artifacts and/or an npm-published CLI, if and
   when there's demand. The package is not yet set up as a published npm
   module (no `bin`/`files` entry), so "install via npm" is not a shipping
   channel today.

A public marketing/landing site, if one is stood up, should link straight to
these channels (Docker command + source repo) rather than collect leads. The
in-app landing page (`src/views/landing.ejs`) is a *different* surface: it is
served by a running instance to its own anonymous visitors, and its primary CTA
is to register/sign in *to that instance*.

## Security posture

- Passwords hashed with `scrypt`; tokens stored only as SHA-256 hashes (secret
  shown once); SSH keys identified by fingerprint.
- Signed session cookies; `Secure` set automatically on HTTPS requests and
  forceable (`CRUX_SECURE_COOKIES`) behind a proxy.
- Conservative response headers; markdown sanitized before render.
- Reverse-proxy trust is opt-in (`CRUX_TRUST_PROXY`) so forwarded headers are
  only honored when you mean them to be.
- Append-only audit log for forensics.
- Atomic metadata writes to avoid corruption on crash.

## Non-goals / boundaries

- **Not a multi-region / HA cluster.** State is one local directory; scale is
  vertical, with availability coming from snapshots and a warm standby, not a
  distributed database.
- **No reimplementation of git.** If `git` can't do it, thecrux doesn't.
- **No telemetry, no phone-home, no central control plane.**
- **No separate enterprise edition.** Capability differences are configuration,
  not code forks.

## Testing

`tests/` covers the pure logic (diff parsing, markdown sanitization, highlight
detection, session signing, password hashing, formatting) and exercises the git
layer end-to-end against real temporary repositories: tree/blob browsing,
history, refs, the full merge matrix (fast-forward, clean merge, conflict), the
HTTP and SSH transports, access control, tokens, SSH keys, orgs, webhooks,
admin, audit, and repo lifecycle. Tests run against an isolated
`CRUX_DATA_DIR` and never touch real data.
