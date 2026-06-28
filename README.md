# thecrux

A self-hosted code hosting solution — like GitHub — built incrementally.

## Status

**v0.5 — markdown & syntax highlighting**

- [x] Create bare git repositories from a web UI
- [x] List repositories on the home page
- [x] Repository detail page with clone instructions
- [x] Keyboard-first UI (command palette, vim nav, light/dark themes)
- [x] Smart-HTTP git clone/push over the web
- [x] Browse files & directories (tree, file view, raw, README preview)
- [x] Commit history — log, per-commit diffs, path-filtered history
- [x] Markdown rendering (sanitized) + syntax highlighting (theme-aware)
- [ ] Branches & tags (with a branch switcher)
- [ ] Pull requests
- [ ] Users & authentication
- [ ] Issues
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
