# Architecture

## Roles

```text
┌──────────────────────────────┐        loopback TCP         ┌────────────────────────────┐
│ omp process (agent)          │  127.0.0.1:<ephemeral>      │ VS Code window             │
│ src/omp/index.ts             │ ◀─────────────────────────▶ │ src/client/*               │
│                              │   newline-delimited JSON    │                            │
│ · endpoint server            │                             │ · endpoint scan (2 s)      │
│ · approval gate              │   register / register_ack   │ · terminal matching        │
│ · pre-edit snapshots         │   approval_request/response │ · diffs, silent opens      │
│ · per-turn ide-context       │   context / context_result  │ · edit history + revert    │
│ · vscode_* tools             │   rpc_request / response    │ · RPC handlers             │
└──────────────────────────────┘                             └────────────────────────────┘
             │                                                             │
             └── publishes ~/.omp-vscode/servers/omp-<pid>-<port>.json ───┘
```

The agent is the server because it owns the session — one listener per omp process, many
windows may attach. The editor is the client because it is the one that must be discovered
and matched to a workspace.

## Modules

| File | Responsibility |
|---|---|
| `src/protocol.ts` | Envelope encode/parse, endpoint record validation, JSON-line decoder, path confinement guard |
| `src/omp/index.ts` | Listener lifecycle, endpoint records, approvals, snapshots, context injection, tool registration |
| `src/client/extension.ts` | Activation, scan loop, status bar, tree view, commands, approval UX |
| `src/client/discovery.ts` | Endpoint directory scan, dead-pid pruning, terminal matching |
| `src/client/connection.ts` | Socket lifecycle, register, ping/pong, backoff, message dispatch |
| `src/client/open-edits.ts` | git-HEAD content provider, proposed-write provider, silent open |
| `src/client/history.ts` | Recent-edit ring buffer (50), revert via workspace FS |
| `src/client/approvals.ts` | "Always Allow" cache keyed `tool:path` in workspace state |
| `src/client/context.ts` | Context composers and the per-turn snapshot |
| `src/client/rpc.ts` | Editor-side RPC handlers (lm tools, diagnostics, commands, debug, tasks) |

## Connection lifecycle

1. **Publish** — on `session_start` the server binds `127.0.0.1:0`, then atomically writes
   `omp-<pid>-<port>.json` (temp file + rename) with pid, parent pid, port, cwd, session id,
   a 32-hex token, timestamps, and the pid ancestry chain.
2. **Scan** — every 2 s the client reads that directory, parses records, and drops any whose
   `pid` is dead.
3. **Match** — the first terminal whose `processId` appears in `ancestorPids` wins.
   Otherwise, if the window has exactly one terminal and the record's `cwd` is inside a
   workspace folder, that terminal is used. A pinned endpoint (`ompBridge.pinSession`)
   bypasses matching entirely.
4. **Register** — the client connects, sends `register` with the token, its window id,
   workspace roots, and `capabilities`. Mismatched token → `error: unauthorized` + close.
5. **Steady state** — the server rewrites `updatedAt` and sends `ping` every 10 s; the client
   answers `pong`. Socket close triggers reconnect with 1 s → 2 s → 4 s … capped at 10 s.
6. **Teardown** — `session_shutdown` rejects pending approvals/RPCs, closes sockets, and
   deletes the record. Records left by crashed processes are swept on the next startup.

## Message flows

### Agent edits a file

```
tool_call  ──▶ snapshot(file) ──▶ approval_request ──▶ [window: Allow | Always Allow | Deny]
                                        │                        │
                    no window / 60 s timeout ────────────────────┘ allows
                                        ▼
                              tool executes (or blocked with reason)
                                        ▼
tool_result ──▶ file_edited { path, previous | created } ──▶ history + diff/silent open
```

### Editor context

- **Automatic** — before each turn the server calls `context.snapshot` (2 s budget) and
  injects the reply as `customType: "ide-context"`, `display: false`. Turn sees editor state
  with no tool round trip.
- **On demand** — commands send `selection`, `file`, `problems`, diff, symbol, tabs, or a
  file pick. `ompBridge.contextDelivery: aside` joins the running turn; `queue` stores it
  without starting one.

### Editor tooling

`vscode_tools`, `vscode_tool`, `vscode_diagnostics`, `vscode_command`, `vscode_debug`,
`vscode_task` are registered by the server and answered by the window through
`rpc_request`/`rpc_response` (30 s timeout). With no window attached they fail fast with
"No VS Code window is connected".

## State and locations

| Location | Contents | Lifetime |
|---|---|---|
| `~/.omp-vscode/servers/*.json` | Endpoint records | While the omp process lives; swept when dead |
| VS Code workspace state | Pinned endpoint, cached approvals | Per workspace |
| VS Code extension memory | Edit history (50), connection snapshots | Per window session |

## Limits

| Limit | Value | Reason |
|---|---|---|
| Frame buffer | 1 MiB | Bound memory on malformed peers |
| Approval wait | 60 s, then allow | A closed window must not wedge the agent |
| Per-turn snapshot RPC | 2 s, then skip | Turn latency budget |
| RPC (tools/commands) | 30 s | Long editor operations |
| Snapshot size | 1 MiB, text only | Revert must never corrupt binaries |
| Edit history | 50 entries | Bounded revert window |
| Command allowlist | Empty by default | Opt-in execution |
