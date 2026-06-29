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

Open a PR from `/:repo/pulls/new` (or the "open PR" link on the branches
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

```bash
git push http://<username>@localhost:3000/my-project.git main
```

Extra config: `CRUX_DATA_DIR` (data location), `CRUX_SECRET` (session signing
key; auto-generated and persisted if unset).
- [ ] Branches & tags
- [ ] Pull requests
- [ ] Users & authentication
- [ ] Issues

You can now actually use thecrux as a git remote:

```bash
git remote add origin http://localhost:3000/my-project.git
git push -u origin main
git clone http://localhost:3000/my-project.git
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

| Variable          | Default            | Description                          |
| ----------------- | ------------------ | ------------------------------------ |
| `PORT`            | `3000`             | HTTP port                            |
| `HOST`            | `127.0.0.1`        | Bind address                         |
| `CRUX_REPOS_DIR`  | `./data/repos`     | Where bare repositories are stored   |

## How it works

Each repository is a real bare git repo (`<name>.git`) created with
`git init --bare`. This keeps thecrux interoperable with standard git from
day one — future increments will serve these repos over the smart-HTTP
protocol so you can `git clone` and `git push` directly.
