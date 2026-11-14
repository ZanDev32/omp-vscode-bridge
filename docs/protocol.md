# Wire protocol v4

Newline-delimited JSON over loopback TCP. Every message carries
`protocol: 4`; peers reject envelopes with a different version, so a mixed install
shows 0 sessions instead of misbehaving.

## Transport and auth

- Server binds `127.0.0.1:0`; the OS picks an ephemeral port. Nothing listens on a public
  interface.
- The port and a 32-hex token are published in the endpoint record below. The client may
  only register with that token; a mismatch returns `error: unauthorized` and closes the
  socket.
- One connection per matched endpoint. Either side may close at any time; the client
  reconnects with exponential backoff.

## Endpoint record

Published atomically at `~/.omp-vscode/servers/omp-<pid>-<port>.json`:

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

`ancestorPids` is the ppid chain, used for terminal matching. Records whose `pid` is dead are
ignored by the client and deleted by the next server startup.

## Client → server

| Message | Fields | Notes |
|---|---|---|
| `register` | `token`, `clientId`, `windowId`, `terminalName?`, `workspaceRoots`, `capabilities` | First frame; answered with `register_ack` or `error` |
| `approval_response` | `requestId`, `allow`, `reason?` | First answer wins across windows |
| `context` | `kind: selection \| file \| problems`, `text`, `insertOnly?`, `cwd?` | `insertOnly` stores for the next turn instead of joining the current one |
| `rpc_response` | `id`, `ok`, `result?` \| `error?` | Reply to `rpc_request` |
| `pong` | — | Reply to `ping` |

## Server → client

| Message | Fields | Notes |
|---|---|---|
| `register_ack` | `sessionId`, `cwd`, `sessionFile?`, `serverPid`, `serverPort`, `features?` | `features` advertises server abilities |
| `session_update` | `sessionId`, `cwd`, `sessionFile?` | After a session switch |
| `approval_request` | `requestId`, `tool: edit \| write`, `path`, `cwd`, `timestamp`, `proposed?` | `proposed` carries the full text for `write` |
| `file_edited` | `sessionId`, `path`, `tool`, `cwd`, `timestamp`, `previous?`, `created?` | `previous` is the pre-edit text; `created` marks a new file |
| `context_result` | `ok`, `message?` | Acknowledgement of a `context` frame |
| `rpc_request` | `id`, `method`, `params` | Editor operation, see below |
| `ping` | — | Every 10 s |
| `error` | `code`, `message` | Fatal for the connection |

## Capabilities and features

`register.capabilities` and `register_ack.features` are string lists. Current values:
`context.snapshot`, `approval`, `tools`, `revert`. The server only requests a capability the
client advertised, so an older peer degrades (no per-turn snapshot) instead of erroring.

## RPC methods

| Method | Params | Returns |
|---|---|---|
| `context.snapshot` | — | Pre-formatted `ide-context` text (2 s budget) |
| `lm.list` | — | JSON array of `{ name, description, tags }` from `vscode.lm.tools` |
| `lm.invoke` | `name`, `input` (JSON string) | Tool result text |
| `diagnostics` | `path?`, `severity?: all \| errors` | One line per diagnostic |
| `command` | `command`, `args` (JSON array string) | Command result, or an error when not allowlisted |
| `debug` | `action: start \| stop`, `name?` | Confirmation text |
| `task` | `action: list \| run`, `name?` | Task list or start confirmation |

Errors are returned as `{ ok: false, error }` and surface to the agent as tool failures.

## Example

```jsonc
// client → server
{"type":"register","protocol":4,"token":"…","clientId":"w1:2458862","windowId":"w1",
 "terminalName":"zsh","workspaceRoots":["/repo"],"capabilities":["context.snapshot","approval","tools","revert"]}
// server → client
{"type":"register_ack","protocol":4,"sessionId":"01a1…","cwd":"/repo",
 "serverPid":2458862,"serverPort":41693,"features":["context.snapshot","approval","tools","revert"]}
```
