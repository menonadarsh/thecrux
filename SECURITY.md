# Security Policy

thecrux is a self-hosted git server — it handles authentication, access control,
sessions, tokens and SSH. Security reports are taken seriously and are very
welcome.

## Reporting a vulnerability

**Please do not open a public issue for security problems.** Public issues
disclose the flaw to everyone before a fix exists.

Instead, report privately via GitHub:

- Go to the repository's **[Security tab](https://github.com/menonadarsh/thecrux/security)**
  → **"Report a vulnerability"** (GitHub private vulnerability reporting).

This opens a private advisory visible only to you and the maintainers.

In your report, please include as much as you can:

- The version / commit you tested (`git rev-parse HEAD`, or the release tag).
- The type of issue (auth bypass, access-control gap, injection, SSRF, RCE,
  session/token handling, etc.).
- Step-by-step reproduction, ideally with a minimal proof of concept.
- The impact — what an attacker can read, write or do.

## What to expect

This is an open-source project maintained on a best-effort basis:

- **Acknowledgement:** typically within a few days.
- **Assessment & fix:** we'll confirm the issue, work on a fix, and keep you
  updated. Timelines depend on severity and complexity.
- **Coordinated disclosure:** we'll agree on a disclosure date with you and
  credit you in the advisory and release notes (unless you'd prefer to remain
  anonymous).

Please give us a reasonable window to ship a fix before disclosing publicly.

## Scope

**In scope** — flaws in thecrux itself, for example:

- Authentication or session weaknesses (login, cookies, `scrypt` handling).
- Access-control gaps (reading/writing repos, PR merges, issue actions, org
  membership, admin/registration policy).
- Git transport issues over Smart-HTTP or SSH (auth, path handling, command
  injection into `git`).
- Token / SSH-key handling, the audit log, webhook delivery/signing.
- Markdown rendering / output-sanitization bypasses (stored XSS).

**Out of scope** — for example:

- Vulnerabilities in a specific *deployment* rather than the code: a missing
  reverse-proxy/TLS, a leaked `CRUX_SECRET`, open registration left on
  intentionally, weak user passwords, or an exposed data dir. See
  [`docs/deploy.md`](docs/deploy.md) for hardening.
- Denial of service from unrealistic traffic volumes.
- Findings from automated scanners without a demonstrated, realistic impact.

## Supported versions

thecrux is pre-1.0 and evolving. Security fixes land on the **latest `main`**
(and the most recent release). Please confirm an issue reproduces on the latest
`main` before reporting.

## Hardening your instance

Much of your security posture is deployment configuration. The
[deployment guide](docs/deploy.md) covers the essentials: terminate TLS at a
reverse proxy (`CRUX_TRUST_PROXY`), pin a strong `CRUX_SECRET`, lock down
registration (`open` / `invite` / `closed`) from the admin panel, bring your own
SSH host key, and back up the data dir.
