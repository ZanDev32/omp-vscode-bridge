# OMP VS Code Bridge

Shows OMP agent file edits in VS Code without stealing focus. Two TypeScript halves in one manifest:

| Path | Role |
|---|---|
| `src/client/` | VS Code extension — discovers endpoints, approves edits, surfaces diffs, records/reverts edits, injects editor context |
| `src/omp/` | OMP extension — publishes one loopback endpoint per omp process, gates `edit`/`write`, snapshots pre-edit content |
| `src/protocol.ts` | Wire format shared by both sides |

`main` points at the compiled client, `omp.extensions` at the server source.

## Install

```bash
bun install
bun run package                                   # → omp-vscode-bridge-<version>.vsix
code --install-extension omp-vscode-bridge-*.vsix # VS Code half
omp plugin link .                                 # OMP half
```

Reload the VS Code window and start a new omp session (new terminal or new chat panel) so the plugin loads.

Verify:

```bash
ls ~/.omp-vscode/servers/     # one omp-<pid>-<port>.json per running omp process
```

The status bar reads `OMP Bridge: <connected>/<detected>`; **OMP Bridge** in the activity bar lists recent edits. Logs go to the **OMP Bridge** output channel.

## What you get

| Surface | Command / key | Behavior |
|---|---|---|
| Per-turn context | automatic | Before each turn the server asks the window for an `ide-context` snapshot — active file, selection, diagnostics — and injects it without starting a turn. Toggle with `ompBridge.shareContext`. |
| Approval gate | automatic | Before every `edit`/`write` the window shows Allow / **Always Allow** / Deny; for `write` the proposed content opens as a diff first. "Always Allow" remembers `tool:path` in workspace state (`ompBridge.forgetApprovals` clears it). Deny returns an error and leaves the file untouched; a 60 s timeout allows. |
| Edit surfacing | automatic | Tracked files open as a HEAD diff, untracked ones as a silent open. `ompBridge.autoOpen` turns the opening off, leaving only history. |
| Revert | **Revert Edit** / tree click | Restores the pre-edit text, or deletes a file the agent created. Snapshots are session-local (last 50 edits) and capped at 1 MB. |
| Context | `Ctrl+Alt+K` selection · `Ctrl+Alt+Shift+K` file · `Ctrl+Alt+Shift+P` problems · `Ctrl+Alt+G` git diff · `Ctrl+Alt+Y` symbol | Sends `@path#LxCy-LxCy` + fenced text, diagnostics, a scoped git diff (`ompBridge.diffScope`), the enclosing LSP symbol, open tabs, or a multi-file pick into the session. `ompBridge.contextDelivery` chooses `aside` (join the running turn) or `queue` (store for the next turn). |
| Session binding | automatic, overridable | Terminals are matched by pid ancestry; **Pin Window to Session** binds this window to one endpoint explicitly when several terminals share a workspace. |
| VS Code tools in omp | `vscode_tools`, `vscode_tool` | Lists and invokes everything in `vscode.lm.tools` — Copilot tools and MCP servers VS Code manages — through `lm.invokeTool`. |
| Editor diagnostics | `vscode_diagnostics` | Prints errors/warnings per file or workspace. |
| Commands | `vscode_command` | Runs an allowlisted command id (`ompBridge.allowedCommands`, default empty) after a modal confirm. |
| Debug / tasks | `vscode_debug`, `vscode_task` | Starts a `launch.json` configuration, stops the active session, lists or runs tasks. |

Settings: `ompBridge.requireApproval` (default on), `ompBridge.autoOpen`, `ompBridge.showDiffs`, `ompBridge.shareContext` (default on), `ompBridge.includeDiagnostics` (default on), `ompBridge.diffScope`, `ompBridge.contextDelivery`, `ompBridge.ignoredPaths` (globs), `ompBridge.allowedCommands` (default empty), `ompBridge.confirmCommands` (default on).

The `vscode_*` tools are registered whether or not a window is connected; without one they fail with "No VS Code window is connected".

Uninstall: `omp plugin uninstall omp-vscode-bridge`, then remove the extension from VS Code.

## How it works

- The server listens on `127.0.0.1:0`, then writes an endpoint record atomically: pid, parent pid, port, cwd, session id, per-process token, and pid ancestry.
- Every 2 s the client reads that directory, discards records whose pid is dead, and matches endpoints to its own window by terminal-pid ancestry — falling back to a single-terminal window whose workspace contains the endpoint cwd.
- On connect the client sends `register` with the record's token plus its `capabilities`; the server answers `register_ack` with its `features` (both lists gate optional behavior, so an unknown peer degrades instead of failing) or drops the connection with `error: unauthorized`.
- Before each turn (`before_agent_start`) the server calls `context.snapshot` (2 s budget) and injects the reply as a `customType: "ide-context"` message; that turn sees the editor state without an extra round trip from the model.
- Before an `edit`/`write`, the server snapshots the file and asks connected windows for approval over `approval_request`; the first `approval_response` wins and a timeout allows. With no window connected the tool runs ungated.
- Successful edits become `file_edited` with the pre-edit text (`previous`) or `created: true`. Virtual devices (`xd://`, `local://`) and non-files are filtered server-side.
- The window may push `context` text, which the server injects into the session with `sendUserMessage({ deliverAs: "aside" })` and acknowledges with `context_result`.
- The client diffs the file against `HEAD` through a `omp-bridge-head` content provider served by `git show`; without a commit it falls back to a silent open. Both keep `preserveFocus`.
- The server heartbeats every 10 s (record rewrite + ping), removes its record on shutdown, and sweeps records left by dead processes at startup.

## Protocol (v4, newline-delimited JSON)

```text
client -> server  {type:"register", protocol, token, clientId, windowId, terminalName?, workspaceRoots, capabilities}
                  {type:"approval_response", protocol, requestId, allow, reason?}
                  {type:"context", protocol, kind:"selection"|"file"|"problems", text, insertOnly?, cwd?}
                  {type:"rpc_response", protocol, id, ok, result?|error?}
                  {type:"pong"}
server -> client  {type:"register_ack", protocol, sessionId, cwd, sessionFile?, serverPid, serverPort, features?}
                  {type:"session_update", protocol, sessionId, cwd, sessionFile?}
                  {type:"approval_request", protocol, requestId, tool, path, cwd, timestamp, proposed?}
                  {type:"file_edited", protocol, sessionId, path, tool, cwd, timestamp, previous?, created?}
                  {type:"context_result", protocol, ok, message?}
                  {type:"rpc_request", protocol, id, method, params}
                  {type:"ping", protocol}
                  {type:"error", protocol, code, message}
```

```json
{
  "protocol": 4,
  "pid": 2458862,
  "parentPid": 2458427,
  "port": 41693,
  "sessionId": "01a1d9db-…",
  "cwd": "/path/to/project",
  "token": "<32 hex chars>",
  "startedAt": "2026-11-14T11:41:00.000Z",
  "updatedAt": "2026-11-14T11:41:00.000Z",
  "ancestorPids": [2458427, 1168781, 1166152]
}
```

## Development

```bash
bun install
bun run typecheck      # tsc --noEmit over src
bun run build          # tsc → dist/ (CommonJS, sourcemaps)
bun run package        # build + vsce package
```

`.vscodeignore` ships only `dist/`, the manifest, the icon, and docs.
