# AGENTS.md

Operating guide for coding agents working in this repository.

## What this is

An IDE bridge between the OMP coding agent and VS Code, shipped as **one** extension
package with two halves:

| Path | Half | Loaded by |
|---|---|---|
| `src/client/` | VS Code extension (editor side) | VS Code via `main` → `dist/client/extension.js` |
| `src/omp/` | OMP plugin (agent side) | omp via `omp.extensions` → `src/omp/index.ts` (TypeScript, no build step) |
| `src/protocol.ts` | Wire format shared by both | imported by both halves |

Direction of control: the **agent is the TCP server**, the **editor is the client**.
The editor also answers RPCs (approvals, diagnostics, tools) over the same socket.

Read `docs/architecture.md` before changing discovery, matching, or timing.
Read `docs/protocol.md` before touching any message shape.

## Commands

```bash
bun install                    # only typescript, @types/node, @types/vscode, @oh-my-pi types
bun run typecheck              # tsc -p tsconfig.check.json (src/, no emit)
bun run build                  # tsc -p tsconfig.json → dist/ (client + protocol only)
bun run package                # build + vsce package --no-dependencies → *.vsix
code --install-extension omp-vscode-bridge-<version>.vsix
omp plugin link .              # agent half
```

## Invariants

- **One protocol version.** `PROTOCOL_VERSION` lives in `src/protocol.ts` and gates every
  envelope. Any wire change bumps it in the same commit as both sides; a mismatched pair
  must fail closed (no sessions) rather than half-work.
- **`dist/` is generated.** Never commit it, never hand-edit it, never import from it in
  source. It is gitignored and excluded from the vsix except what `main` needs.
- **Client stays CommonJS.** No `"type": "module"` in `package.json`; `tsconfig.json` uses
  `module: node16` precisely so the client emits CJS for the extension host. The agent half
  is loaded straight from TS by omp, which is why its type-only import carries
  `with { "resolution-mode": "import" }`.
- **`engines.vscode` ≥ `@types/vscode`.** `vsce` refuses to package otherwise; bump both
  together when the API surface moves.
- **The vsix is defined by `.vscodeignore`.** `src/`, `docs/`, `AGENTS.md`, lockfiles, maps,
  and tsconfigs stay out. Adding a runtime file means adding it to `dist` output instead.
- **Approval fails open, deliberately.** No connected window or a 60 s timeout lets the tool
  run; denial is explicit. Do not flip this to fail-closed without a design note in
  `docs/security.md`.
- **Command execution is opt-in.** `ompBridge.allowedCommands` defaults to empty and each
  call is confirmed. Never ship a broader default.
- **Snapshots are bounded.** Pre-edit text ≤ 1 MB and never binary (NUL check); skipped
  snapshots must degrade to "no snapshot for this edit", not to writing garbage.
- **No content in logs.** The output channel and `pi.logger` lines name paths and counts,
  never file bodies or tokens.

## Conventions

- TypeScript strict, no runtime dependencies; dev deps only.
- One concern per module (see the file table in `docs/architecture.md`); export named
  functions, not classes, unless lifecycle demands it.
- Failures bubble as thrown `Error` with an actionable message; the agent surfaces them as
  tool errors. Silent catches are allowed only where the code comments say why (unreadable
  endpoint records, malformed frames).
- Conventional Commits, subject ≤ 72 chars, scopes: `protocol`, `omp`, `client`, `docs`, `chore`.

## Verification before finishing

1. `bun run typecheck` — both halves.
2. `bun run build` — must emit `dist/client/extension.js` and friends.
3. `bun run package` — vsix builds; engines/types check passes.
4. Behavioral check against a live agent session (see `docs/development.md` for the harness
   recipe): start `omp` in a scratch git repo, drive the change, observe the RPC/approval
   traffic from the server side.
5. `git status` clean; new files added intentionally; `.vscodeignore` still correct.
