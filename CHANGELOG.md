# Changelog

All notable changes to thecrux are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-07-01

First public release of **thecrux** — a self-hosted git server that runs on your
own box and never phones home. Keyboard-first, private by default, with issues
and pull requests built in.

### Added

**Git, the real thing**
- Bare git repositories on disk — fully interoperable with any git client.
- Clone/fetch/push over **Smart-HTTP** and **SSH** (per-account keys).
- **Revocable access tokens** for HTTP push — your password never touches
  `git` config.

**Collaboration**
- **Pull requests** — compare refs, view diffs, server-side merge (fast-forward
  or a true merge commit) with conflict detection.
- **Issues** — open/close, labels, assignees, markdown comment threads.
- **Organizations** — shared repo namespaces with owners and members.

**Access & control**
- **Private by default**; per-repo owner + collaborators, public when you choose.
- **Admin panel** — open / invite-only / closed registration, user management.
- **Post-receive webhooks** (optional HMAC-signed) and an append-only
  **audit log**.

**Runs anywhere, owns nothing of yours**
- A single **Node app + Docker**, no database — everything is files under one
  data dir, so a backup is a `tar`.
- Keyboard-first UI: ⌘K command palette, vim-style navigation, light/dark themes.
- No telemetry, no phone-home.

### Docs
- [README](README.md) · [Design](docs/design.md) · [Deploy](docs/deploy.md) ·
  [Security](SECURITY.md)

[0.1.0]: https://github.com/menonadarsh/thecrux/releases/tag/v0.1.0
