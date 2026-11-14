# Security model

## Assets

1. The ability to write files the agent asks for.
2. The ability to run VS Code commands, debug sessions, and tasks.
3. Editor content (file bodies, selections, diagnostics) shared with the agent.

## Controls

| Threat | Control |
|---|---|
| Another machine reaching the bridge | Listener binds `127.0.0.1` only; no external interface |
| Another local user connecting | Endpoint records carry a 32-hex token; `register` with a wrong token returns `error: unauthorized` and closes |
| Stale process squatting a port | Records are validated and dropped when `pid` is dead; records are swept at startup |
| Agent writing code you did not want | Approval gate before every `edit`/`write`; `write` proposals render as a diff first; denial returns an error to the model |
| Approval fatigue | "Always Allow" caches only `tool:path` in workspace state; `ompBridge.forgetApprovals` clears it |
| Agent running arbitrary editor commands | `ompBridge.allowedCommands` is empty by default; allowlisted calls still show a modal confirm |
| Path traversal through a tool payload | Server resolves and confines every reported path to the session cwd; the client confines surfacing to workspace roots; `xd://`/`local://` are rejected |
| Revert corrupting binaries or huge files | Snapshots capped at 1 MiB and skipped when the file contains NUL; no snapshot means revert refuses |
| Leaking content into logs | Log lines carry paths, counts, and method names only |
| Secret exfiltration by a compromised extension | Nothing is authenticated beyond the token; treat any extension in the window as trusted — see residual risks |
| Cross-origin data flow | No network egress from the bridge; all traffic is loopback, no telemetry |

## Deliberate tradeoffs

- **Approval fails open.** No connected window, or a 60 s timeout, lets the tool run. This
  keeps a closed window from wedging an agent mid-task; the cost is that an unattended
  session is ungated. Set `ompBridge.requireApproval: false` to make that explicit.
- **`vscode_command` is allowlist-gated, not sandboxed.** An allowlisted command id runs with
  the extension host's full privileges. Choose ids accordingly.
- **`vscode_tool` delegates consent.** Language-model tools (including MCP servers VS Code
  manages) apply their own permission prompts; the bridge does not add a second gate.
- **Snapshots live in process memory** for the session's lifetime, capped by the 1 MiB rule;
  nothing is written to disk.

## Residual risks

- Any process running as the same user can read `~/.omp-vscode/servers/*.json` (mode 0644 by
  default) and therefore impersonate the editor. This is the same trust boundary as the
  agent's own credentials.
- The status bar and quick pick reveal file paths to anyone who can see the screen.
- Workspace state stores cached approvals in plain text; it is scoped to the workspace, not
  encrypted.

## Reporting

Open an issue describing the class of problem (auth, path confinement, approval bypass) with
a reproduction. Do not include tokens, file contents, or logs from a private project.
