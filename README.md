# thecrux

A self-hosted code hosting solution — like GitHub — built incrementally.

## Status

**v0.9 — issues & comments** — _roadmap complete_ 🎉

- [x] Create bare git repositories from a web UI
- [x] List repositories on the home page
- [x] Repository detail page with clone instructions
- [x] Keyboard-first UI (command palette, vim nav, light/dark themes)
- [x] Smart-HTTP git clone/push over the web
- [x] Browse files & directories (tree, file view, raw, README preview)
- [x] Commit history — log, per-commit diffs, path-filtered history
- [x] Markdown rendering (sanitized) + syntax highlighting (theme-aware)
- [x] Branches & tags — overview pages, ref switcher, repo subnav
- [x] Users & authentication — accounts, sessions, repo ownership, push auth
- [x] Pull requests — compare refs, view diff, merge (ff + merge commit)
- [x] Issues — tracker with open/close and markdown comment threads
      (the same thread powers pull-request conversations)

### Pull requests

Open a PR from `/:owner/:repo/pulls/new` (or the "open PR" link on the branches
page), comparing a compare ref into a base ref. The PR page shows the commits
and combined diff and, for signed-in users, a merge button. Merges are
performed server-side directly on the bare repo: fast-forward when possible,
otherwise a real two-parent merge commit (`git merge-tree` + `commit-tree`).
Conflicting branches are detected and blocked.

### Authentication

- Register at `/register`, sign in at `/login`. Passwords are hashed with
  scrypt; sessions are signed cookies.
- Creating a repository requires being signed in; the creator is recorded as
  the repo **owner**.
- **`git push` requires authentication** (HTTP Basic, your crux username +
  password). Cloning is anonymous.

### Access control

Each repo has an **owner** (its namespace) with full/admin rights and a list of
**collaborators** with write access, managed on the repo's `/settings` page
(owner only). Browsing and cloning are public; **write actions** — `git push`,
merging pull requests, and closing/reopening issues & PRs — require write
access (an author may always close/reopen their own issue or PR). Push without
access returns `403`.

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

## Configuration

Environment variables:

| Variable             | Default            | Description                                         |
| -------------------- | ------------------ | --------------------------------------------------- |
| `PORT`               | `3000`             | HTTP port                                           |
| `HOST`               | `127.0.0.1`        | Bind address                                        |
| `CRUX_REPOS_DIR`     | `./data/repos`     | Where bare repositories are stored                  |
| `CRUX_SSH_ENABLED`   | `true`             | Enable the git-over-SSH server (`0` to disable)     |
| `CRUX_SSH_PORT`      | `2222`             | SSH port (unprivileged so it works without root)    |
| `CRUX_SSH_HOST`      | `$HOST`            | SSH bind address                                    |
| `CRUX_SSH_HOST_KEY`  | _(generated)_      | Path to a PEM host key — bring your own for stable `known_hosts` across replicas |

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
`git init --bare`. This keeps thecrux interoperable with standard git from
day one — future increments will serve these repos over the smart-HTTP
protocol so you can `git clone` and `git push` directly.
