# Development

## Prerequisites

- VS Code 1.146 or newer (the manifest's `engines.vscode` tracks `@types/vscode`; `vsce`
  rejects a package where the types are newer than the engine range).
- Bun for the dev loop, plus `omp` on `PATH` for live testing.
- `@vscode/vsce` is invoked through `npx` by the `package` script; no global install needed.

## Loop

```bash
bun install
bun run typecheck     # tsc -p tsconfig.check.json → src/ (client AND agent half)
bun run build         # tsc -p tsconfig.json → dist/ (client + protocol)
bun run package       # build + vsce package --no-dependencies
code --install-extension omp-vscode-bridge-<version>.vsix
omp plugin link .
```

Then reload the VS Code window and start a new omp session. The agent half is loaded from
`src/omp/index.ts` directly, so a plugin change needs a new omp process; the client half needs
a window reload.

After a change that touches both halves, bump `version` in `package.json` — VS Code keeps the
highest installed version and silently ignores a reinstall of the same one.

## Two tsconfigs

| File | Purpose |
|---|---|
| `tsconfig.json` | Emit: client + protocol only, CommonJS, `outDir: dist` |
| `tsconfig.check.json` | `noEmit` over all of `src`, including the agent half and its ESM type import |

`dist/` is gitignored and excluded from the vsix except the client entry and its imports.

## Verifying behavior

Unit tests do not exist yet; verification is behavioral. The fastest reliable loop:

1. Create a scratch repo with one commit so diffs have a `HEAD`:
   ```bash
   mkdir -p /tmp/bridge-check && cd /tmp/bridge-check && git init -q
   printf 'original\n' > tracked.txt && git add -A && git -c user.name=t -c user.email=t@t commit -qm init
   ```
2. Start the agent there in a PTY (omp needs a terminal) and keep it running.
3. Drive it from a small Node harness that loads `dist/client/*.js` with a stubbed `vscode`
   module — intercept `Module._load` and return the stub for `"vscode"`. Use **Node**, not
   Bun: Bun replaces the module loader and ignores the hook.
4. Assert on what crosses the socket: `register_ack`, `approval_request`, `file_edited`
   (`previous` content), `context_result`, and `rpc_request` methods.
5. For the client UI paths, stub `showInformationMessage`, `showTextDocument`, and
   `executeCommand`, then assert the calls (`vscode.diff` with the `omp-bridge-head` URI).

Checks worth repeating before a release: approval allow and deny, revert restoring exact
bytes, `xd://` writes ignored, per-turn snapshot injected, command allowlist refusal.

## Debugging

- Client: **OMP Bridge: Show Log File** (output channel) — connection state, RPC methods,
  approval decisions, ignored paths.
- Agent: `pi.logger.debug` lines (`bridge: endpoint published`, `client registered`,
  `approval timed out`).
- Socket state: `ss -tnp | grep <port>` should show a `code` ↔ `omp` pair.
- Endpoint records: `ls ~/.omp-vscode/servers/` should contain exactly the live processes.

## Releasing to Open VSX

Publishing authenticates with a **personal access token** kept as the repository secret
`OVSX_PAT`. The workflow verifies the token with `ovsx verify-pat` before uploading, so a bad
or expired token fails with a clear message instead of a partial publish.

One-time setup:

1. Sign in at <https://open-vsx.org> with GitHub and claim the `zandev32` namespace — it must
   match the manifest `publisher`.
2. Create a token at <https://open-vsx.org/user-settings/tokens>.
3. Add it as an Actions secret named `OVSX_PAT` (Settings → Secrets and variables → Actions).
   Repository or environment scope both work; an environment secret requires adding
   `environment: <name>` to the job.

Local publish, if you ever need it:

```bash
npx ovsx verify-pat zandev32 -p "$OVSX_PAT"
npx ovsx publish ./*.vsix -p "$OVSX_PAT"
```

Release:

```bash
# bump "version" in package.json, commit, then
git tag v0.7.0
git push origin master --tags
```

The tag must equal `v<package.json version>`; the workflow fails otherwise. Manual runs accept
a `dry_run` input that builds and checks without publishing.

CI (`.github/workflows/ci.yml`) runs typecheck, build, and package on every push to `master`
and on pull requests, and uploads the vsix as an artifact.

**Migration path:** Open VSX supports trusted publishing (GitHub OIDC, no stored secret). When
you switch, register the repository and workflow on the publisher page and replace the two
publish steps with `npx ovsx publish --trusted-publishing`, then delete `OVSX_PAT`.

## Release checklist

1. `bun run typecheck && bun run package`
2. Bump `version`; update `CHANGELOG`-worthy notes in the commit body.
3. Confirm `.vscodeignore` still excludes `src/`, `docs/`, `AGENTS.md`, maps, lockfiles.
4. Install the vsix, reload, and confirm the status bar shows `<connected>/<detected>`.
5. Tag the commit if publishing.
