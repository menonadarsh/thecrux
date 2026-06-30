# thecrux

A self-hosted git server — like GitHub, but it runs on your own box and your
code never leaves it. Keyboard-first web UI, issues and pull requests, private
by default. The crux is in the code.

> **Architecture & design:** [`docs/design.md`](docs/design.md).
> **Running it in production:** [`docs/deploy.md`](docs/deploy.md).

## Status

A self-hosted git server you can actually run. What's in the box:

- [x] Create bare git repositories from a web UI — **private by default**
- [x] Owner-namespaced repos (`/:owner/:repo`) for users **and organizations**
- [x] Keyboard-first UI (command palette, vim nav, light/dark themes)
- [x] **Smart-HTTP** git clone/push over the web
- [x] **git over SSH** with per-account public keys
- [x] Browse files & directories (tree, file view, raw, README preview)
- [x] Commit history — log, per-commit diffs, path-filtered history
- [x] Markdown rendering (sanitized) + syntax highlighting (theme-aware)
- [x] Branches & tags — overview pages, ref switcher, repo subnav
- [x] Users & authentication — accounts, sessions, **revocable access tokens**
- [x] Access control — owner + collaborators, private/public, org membership
- [x] Pull requests — compare refs, view diff, merge (ff + merge commit)
- [x] Issues — tracker with open/close, labels, assignees, markdown threads
      (the same thread powers pull-request conversations)
- [x] **Organizations** — shared repo namespaces with owners and members
- [x] **Post-receive webhooks** (optional HMAC-signed payloads)
- [x] **Admin panel** — open / invite-only / closed registration, user management
- [x] **Audit log** + **backup/restore** CLI

## Get thecrux

thecrux is open source (MIT) and **distributed freely — no account, no email
gate, no license server**. Download it and run it. The only account you ever
create is the one on your **own instance** after you deploy it (the first such
account becomes that instance's admin).

The headline path is **Docker**:

```bash
docker run -p 3000:3000 -p 2222:2222 -v crux-data:/data thecrux   # → http://localhost:3000
```

Or from source (Node ≥ 20 and `git` on the host):

```bash
git clone <this-repo> && cd thecrux
npm install
npm run dev      # auto-reload at http://127.0.0.1:3000
```

See [Deployment](#deployment-docker) below and
[`docs/deploy.md`](docs/deploy.md) for the production setup (TLS, SSH, backups).

### Pull requests

Open a PR from `/:owner/:repo/pulls/new` (or the "open PR" link on the branches
page), comparing a compare ref into a base ref. The PR page shows the commits
and combined diff and, for signed-in users, a merge button. Merges are
performed server-side directly on the bare repo: fast-forward when possible,
otherwise a real two-parent merge commit (`git merge-tree` + `commit-tree`).
Conflicting branches are detected and blocked.

### Authentication

- Register at `/register`, sign in at `/login`. Passwords are hashed with
  scrypt; sessions are signed cookies. The **first** account on a fresh
  instance becomes the **admin**; after that, account creation follows the
  instance's registration policy (open / invite-only / closed).
- Creating a repository requires being signed in; the creator is recorded as
  the repo **owner**.
- **`git push` requires authentication** — HTTP Basic with your username plus
  either your password or, preferred, a **revocable access token** created on
  your account page. The token is shown once and stored only as a hash.
- For **git over SSH**, add a public key on your account page (see below).

### Access control

Each repo has an **owner** (its namespace) with full/admin rights and a list of
**collaborators** with write access, managed on the repo's `/settings` page
(owner only). For an **organization** namespace, org owners administer and any
org member can write. Repos are **private by default** — visible and cloneable
only by people with access — and can be flipped to public, in which case
browsing and cloning are open to everyone. **Write actions** — `git push`,
merging pull requests, and closing/reopening issues & PRs — require write
access (an author may always close/reopen their own issue or PR). Reads on a
private repo without access return `404`/`403`; a push without access returns
`403`.

```bash
git push http://<username>@localhost:3000/<username>/my-project.git main
```

Extra config: `CRUX_DATA_DIR` (data location), `CRUX_SECRET` (session signing
key; auto-generated and persisted if unset).

### Repositories are owner-namespaced

Every repo lives under its owner: the web URL is `/:owner/:repo` and the git
remote is `/:owner/:repo.git`. A user page at `/:owner` lists that owner's
repos. On disk, repos are stored at `data/repos/<owner>/<name>.git`; legacy
flat repos are migrated into the `legacy/` namespace automatically on startup.

```bash
git remote add origin http://localhost:3000/<username>/my-project.git
git push -u origin main
git clone http://localhost:3000/<username>/my-project.git
```

## Tech stack

- Node.js + TypeScript
- Express + EJS (server-rendered UI)
- Real **bare git repositories** stored on disk (`data/repos/`)

## Getting started

```bash
npm install
npm run dev      # start with auto-reload at http://127.0.0.1:3000
```

Production build:

```bash
npm run build
npm start
```

## Deployment (Docker)

See [`docs/deploy.md`](docs/deploy.md) for the full guide — reverse proxy + TLS,
SSH, backups/restore, and upgrades. The essentials:

thecrux ships a multi-stage `Dockerfile` (the runtime image includes `git`,
which the app shells out to) and a `docker-compose.yml`.

```bash
docker compose up --build      # http://localhost:3000
```

Hosted repos, user accounts, and the session secret persist in the named
`crux-data` volume (mounted at `/data` inside the container). To run the image
directly instead of compose:

```bash
docker build -t thecrux .
docker run -p 3000:3000 -v crux-data:/data thecrux
```

Inside the container the server binds `0.0.0.0:3000` and uses `CRUX_DATA_DIR=/data`.
Set `CRUX_SECRET` to pin the session signing key across rebuilds (otherwise one
is generated and stored under `/data`).

## Testing

```bash
npm test        # node:test via tsx — unit + git integration
npm run typecheck
```

The suite (in `tests/`) covers the pure logic — diff parsing, markdown
sanitization, syntax-highlight language detection, session signing, password
hashing, formatting — and exercises the git layer end-to-end against real
temporary repositories: tree/blob browsing, history, refs, and the full merge
matrix (fast-forward, clean merge commit, and conflict detection). Tests run
against an isolated `CRUX_DATA_DIR` and never touch your real data.

## Backups

Everything lives under the data dir, so a backup is a snapshot of it:

```bash
npm run crux -- backup --out /var/backups/thecrux        # write a .tar.gz
npm run crux -- restore /var/backups/thecrux/thecrux-backup-….tar.gz
```

In Docker, run `node dist/cli.js backup`/`restore` inside the container. See
[`docs/deploy.md`](docs/deploy.md#backups) for scheduling and consistency notes.

## Configuration

Environment variables:

| Variable               | Default            | Description                                         |
| ---------------------- | ------------------ | --------------------------------------------------- |
| `PORT`                 | `3000`             | HTTP port                                           |
| `HOST`                 | `127.0.0.1`        | Bind address                                        |
| `CRUX_DATA_DIR`        | `./data`           | Base data directory (repos, users, secret, …)       |
| `CRUX_REPOS_DIR`       | `$CRUX_DATA_DIR/repos` | Where bare repositories are stored              |
| `CRUX_SECRET`          | _(generated)_      | Session signing key; pin it across rebuilds/replicas |
| `CRUX_TRUST_PROXY`     | `false`            | Trust `X-Forwarded-*` from a TLS-terminating proxy (e.g. `1`) |
| `CRUX_SECURE_COOKIES`  | `false`            | Force the `Secure` cookie flag (auto-set on HTTPS anyway) |
| `CRUX_SSH_ENABLED`     | `true`             | Enable the git-over-SSH server (`0` to disable)     |
| `CRUX_SSH_PORT`        | `2222`             | SSH port (unprivileged so it works without root)    |
| `CRUX_SSH_HOST`        | `$HOST`            | SSH bind address                                    |
| `CRUX_SSH_HOST_KEY`    | _(generated)_      | Path to a PEM host key — bring your own for stable `known_hosts` across replicas |

### git over SSH

Add your public key on `/settings`, then:

```bash
git clone ssh://git@your-host:2222/<username>/my-project.git
```

- **Turnkey:** the SSH server is on by default; in Docker just map the port
  (`2222:2222`, or `22:2222` to allow bare `git@host` URLs).
- **Self-managed:** set `CRUX_SSH_PORT`/`CRUX_SSH_HOST` to taste, point
  `CRUX_SSH_HOST_KEY` at your own host key so `known_hosts` stays stable, or set
  `CRUX_SSH_ENABLED=0` to run HTTPS-only.

## How it works

Each repository is a real bare git repo (`<name>.git`) created with
`git init --bare`, stored under the owner's namespace at
`data/repos/<owner>/<name>.git`. thecrux serves and manipulates these with
stock `git` plumbing — there's no reimplementation of git — so it's fully
interoperable with any git client, and a repo dir is never trapped: copy it and
its issues, PRs, collaborators and visibility (all `crux-*` sidecar files) come
with it. Both transports (Smart-HTTP and SSH) authenticate against the same
user store and the same per-repo access rules, then hand the object transfer to
`git`.

There is **no database** — accounts, orgs, instance settings, the session
secret and the audit log all live as files under one data dir, which is why
backups are a `tar` and moving hosts is a copy.

For the full picture — data model, request lifecycle, security posture and the
distribution model — see [`docs/design.md`](docs/design.md).
