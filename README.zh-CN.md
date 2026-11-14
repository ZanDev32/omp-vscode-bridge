# OMP VS Code Bridge

[English](README.md) | 简体中文

在 VS Code 中显示 OMP 智能体的文件改动，不抢占焦点。一个清单文件承载两个 TypeScript 半边：

| 路径 | 作用 |
|---|---|
| `src/client/` | VS Code 扩展 —— 发现端点、审批改动、展示 diff、记录与回滚编辑、注入编辑器上下文 |
| `src/omp/` | OMP 扩展 —— 每个 omp 进程发布一个回环端点，拦截 `edit`/`write`，快照编辑前内容 |
| `src/protocol.ts` | 两端共用的通信格式 |

`main` 指向编译后的客户端，`omp.extensions` 指向服务端源码。

## 安装

```bash
bun install
bun run package                                   # → omp-vscode-bridge-<version>.vsix
code --install-extension omp-vscode-bridge-*.vsix # VS Code 半边
omp plugin link .                                 # OMP 半边
```

重载 VS Code 窗口，并新开一个 omp 会话（新终端或新聊天面板）以加载插件。

验证：

```bash
ls ~/.omp-vscode/servers/     # 每个运行中的 omp 进程对应一个 omp-<pid>-<port>.json
```

状态栏显示 `OMP Bridge: <已连接>/<已发现>`；活动栏中的 **OMP Bridge** 列出最近的编辑。日志输出在 **OMP Bridge** 输出通道。

## 功能

| 功能 | 命令 / 快捷键 | 行为 |
|---|---|---|
| 每轮上下文 | 自动 | 每轮开始前，服务端向窗口索取 `ide-context` 快照（当前文件、选区、诊断），并注入给模型，不会额外开启一轮。可用 `ompBridge.shareContext` 关闭。 |
| 审批门 | 自动 | 每次 `edit`/`write` 前弹窗提供 允许 / **始终允许** / 拒绝；`write` 会先以 diff 展示拟写入内容。"始终允许"按 `tool:path` 记入工作区状态（`ompBridge.forgetApprovals` 可清除）。拒绝会把错误返回给模型且不改动文件；60 秒无响应视为允许。 |
| 改动展示 | 自动 | 已跟踪文件以 HEAD diff 打开，未跟踪文件静默打开。`ompBridge.autoOpen` 关闭后只记录不打开。 |
| 回滚 | **Revert Edit** / 树节点 | 恢复编辑前文本；对智能体新建的文件执行删除。快照仅限本会话（最多 50 条，单文件上限 1 MB）。 |
| 上下文发送 | `Ctrl+Alt+K` 选区 · `Ctrl+Alt+Shift+K` 文件 · `Ctrl+Alt+Shift+P` 问题 · `Ctrl+Alt+G` git diff · `Ctrl+Alt+Y` 符号 | 发送 `@path#LxCy-LxCy` 加代码块、诊断、按作用域的 git diff（`ompBridge.diffScope`）、光标所在 LSP 符号、打开的标签页或多选文件。`ompBridge.contextDelivery` 可选 `aside`（并入当前轮）或 `queue`（留到下一轮）。 |
| 会话绑定 | 自动，可覆盖 | 终端默认按进程祖先匹配；**Pin Window to Session** 可在同一工作区多终端时显式绑定。 |
| VS Code 工具 | `vscode_tools`、`vscode_tool` | 列出并调用 `vscode.lm.tools`（含 VS Code 管理的 MCP 服务与 Copilot 工具），走 `lm.invokeTool`。 |
| 诊断 | `vscode_diagnostics` | 输出单文件或整个工作区的错误与警告。 |
| 命令 | `vscode_command` | 仅执行 `ompBridge.allowedCommands` 白名单内的命令（默认空），每次调用弹窗确认。 |
| 调试 / 任务 | `vscode_debug`、`vscode_task` | 启动 `launch.json` 配置、停止当前调试会话、列出或运行任务。 |

设置：`ompBridge.requireApproval`（默认开）、`ompBridge.autoOpen`、`ompBridge.showDiffs`、`ompBridge.shareContext`（默认开）、`ompBridge.includeDiagnostics`（默认开）、`ompBridge.diffScope`、`ompBridge.contextDelivery`、`ompBridge.ignoredPaths`（glob）、`ompBridge.allowedCommands`（默认空）、`ompBridge.confirmCommands`（默认开）。

`vscode_*` 工具无论窗口是否连接都会注册；未连接时返回 "No VS Code window is connected"。

未安装时卸载：先 `omp plugin uninstall omp-vscode-bridge`，再从 VS Code 移除扩展。

## 文档

[`docs/`](docs/README.md) 包含架构、通信协议、开发流程、安全模型与故障排查。面向智能体与贡献者的规则见 [`AGENTS.md`](AGENTS.md)。

## 工作原理

- 服务端在 `127.0.0.1:0` 监听，随后原子写入端点记录：pid、父 pid、端口、cwd、会话 id、每进程令牌以及进程祖先链。
- 客户端每 2 秒扫描该目录，丢弃 pid 已失效的记录，先按终端进程祖先匹配；若窗口只有一个终端且包含端点 cwd，则回退到该终端。
- 连接时客户端发送带令牌与 `capabilities` 的 `register`；服务端返回带 `features` 的 `register_ack`，令牌不符则报 `error: unauthorized` 并断开。
- 每轮开始前（`before_agent_start`）服务端调用 `context.snapshot`（2 秒预算），把结果作为 `customType: "ide-context"` 消息注入，本轮即可看到编辑器状态。
- `edit`/`write` 前服务端快照文件并广播 `approval_request`；首个 `approval_response` 生效，超时放行。无窗口连接时不拦截。
- 成功编辑以 `file_edited` 下发，携带编辑前文本（`previous`）或 `created: true`。虚拟设备（`xd://`、`local://`）与非文件会被过滤。
- 窗口可发送 `context` 文本，服务端用 `sendUserMessage({ deliverAs: "aside" })` 注入或按需排队，并回 `context_result`。

## 通信协议（v4，换行分隔 JSON）

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

端点记录写入 `~/.omp-vscode/servers/omp-<pid>-<port>.json`：

```json
{
  "protocol": 4,
  "pid": 2458862,
  "parentPid": 2458427,
  "port": 41693,
  "sessionId": "01a1d9db-…",
  "cwd": "/path/to/project",
  "token": "<32 位十六进制>",
  "startedAt": "2026-11-14T11:41:00.000Z",
  "updatedAt": "2026-11-14T11:41:00.000Z",
  "ancestorPids": [2458427, 1168781, 1166152]
}
```

## 开发

```bash
bun install
bun run typecheck      # 对 src 执行 tsc --noEmit
bun run build          # tsc → dist/（CommonJS，含 sourcemap）
bun run package        # build + vsce package
```

`.vscodeignore` 仅将 `dist/`、清单、图标与文档打包进 vsix。
