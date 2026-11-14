# Security policy

## Scope

This repository contains an IDE bridge: a VS Code extension that talks to the OMP coding
agent over loopback TCP. In scope:

- Authentication of the bridge socket (endpoint records, tokens).
- Path confinement for reported edits and snapshots.
- The approval gate and the command allowlist.
- Anything that could leak file contents, tokens, or command output.

The detailed threat model, controls, and deliberate tradeoffs live in
[docs/security.md](docs/security.md).

## Supported versions

Only the latest released version is supported. The client and the agent plugin must come
from the same checkout — a mixed pair is unsupported by design (the protocol version check
refuses to connect).

## Reporting a vulnerability

Use GitHub's private reporting:
<https://github.com/ZanDev32/omp-vscode-bridge/security/advisories/new>

Please include the class of issue (auth bypass, path escape, approval bypass, data leak), the
protocol messages involved, and reproduction steps. Do not attach real tokens, private source
files, or logs from a confidential workspace.

You can expect an acknowledgement within a few days. Fixes ship as a normal release; the
advisory is published once a patched version is available.

## Known tradeoffs, not vulnerabilities

These are documented decisions, not bugs:

- **Approvals fail open** when no window is connected or after a 60 s timeout, so a closed
  window cannot wedge the agent. See "Deliberate tradeoffs" in [docs/security.md](docs/security.md).
- **Any process running as the same user** can read `~/.omp-vscode/servers/*.json` and
  impersonate the editor. This is the same trust boundary as the agent's own credentials.
- **Allowlisted VS Code commands** run with the extension host's privileges; the allowlist is
  empty by default.
