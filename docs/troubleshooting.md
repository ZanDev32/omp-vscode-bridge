# Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Status bar reads `0 sessions` | No endpoint records, or none matched | `ls ~/.omp-vscode/servers/`; if empty, the agent half is not loaded. Run `omp plugin list`, `omp plugin link .`, then start a **new** omp process. |
| Records exist, still `0 sessions` | Peer protocol mismatch (client and plugin from different versions) | Both halves must be rebuilt from the same checkout: reload the window after installing the vsix. |
| `0 sessions` only in multi-terminal windows | Matching needs pid ancestry; the terminal that spawned omp is not the one VS Code reports | **OMP Bridge: Pin Window to Session** and pick the `pid:port` entry. |
| Status shows `connecting` forever | Endpoint record is stale or the port is firewalled | Check `ss -tnp \| grep <port>`; kill the omp process so the record is swept, or restart it. |
| No approval modal appears | `ompBridge.requireApproval` is off, the tool+path is cached, or no window is connected | Check the output channel for `auto-approved`/`approval requested`; run **OMP Bridge: Forget Saved Approvals**. |
| Agent runs writes with no prompt | Approval fails open when nobody is connected | Keep the window open, or pin the session; see `docs/security.md`. |
| Warning: `No git HEAD for diff` | Repo has no commits, or the file is untracked | Commit once (`git add -A && git commit -m init`); untracked files open silently by design. |
| Diff view is empty | File was created by the agent in this session | Expected: there is no `HEAD` version to compare. |
| Revert says "no snapshot for this edit" | File was > 1 MiB, binary, or edited before the plugin loaded | Manual undo; snapshots are session-local and size-capped. |
| `vscode_*` tools fail with "No VS Code window is connected" | Agent started outside a VS Code terminal, or the window was reloaded | Start omp in a VS Code terminal of the target workspace. |
| `vscode_command` refused | Command id not in `ompBridge.allowedCommands` | Add the exact id to settings; each call still needs the modal confirm. |
| No per-turn context reaches the agent | `ompBridge.shareContext` off, no connected window, or snapshot exceeded 2 s | Check the output channel for `rpc context.snapshot`; re-enable the setting. |
| `vsce` fails: `@types/vscode greater than engines.vscode` | Types newer than the engine range | Bump `engines.vscode` to match the installed `@types/vscode` (and confirm the local VS Code is at least that version). |
| Reinstalling the same vsix changes nothing | VS Code keeps the highest installed version | Bump `version` in `package.json` before packaging. |
| Old extension keeps loading | Previous versions stay on disk | Remove stale `~/.vscode/extensions/omp-vscode-bridge-*` directories, then reload. |
