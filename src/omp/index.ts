/**
 * OMP side of the bridge.
 *
 * Publishes one loopback endpoint per omp process and negotiates with VS Code:
 * approval for edit/write, pre-edit content for review and revert, and injected
 * editor context from the window.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types" with { "resolution-mode": "import" };
import { PROTOCOL_VERSION, encode, type EndpointRecord } from "../protocol";

const ENDPOINT_DIR = path.join(os.homedir(), ".omp-vscode", "servers");
const HEARTBEAT_MS = 10_000;
const APPROVAL_TIMEOUT_MS = 60_000;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_CONTEXT_BYTES = 1024 * 1024;
const RPC_TIMEOUT_MS = 30_000;

type Endpoint = EndpointRecord & { recordPath: string; sessionFile?: string };
type Snapshot = { previous?: string; created?: boolean };

function ancestorPids(pid: number): number[] {
	const pids: number[] = [];
	let current = pid;
	for (let depth = 0; depth < 16 && current > 1; depth++) {
		pids.push(current);
		try {
			const stat = fs.readFileSync(`/proc/${current}/stat`, "utf8");
			current = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
		} catch {
			break;
		}
	}
	return pids;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function sweepStaleRecords(keepPid: number): void {
	let names: string[];
	try {
		names = fs.readdirSync(ENDPOINT_DIR).filter(name => name.endsWith(".json"));
	} catch {
		return;
	}
	for (const name of names) {
		const file = path.join(ENDPOINT_DIR, name);
		try {
			const record = JSON.parse(fs.readFileSync(file, "utf8"));
			if (typeof record?.pid === "number" && record.pid !== keepPid && !isAlive(record.pid)) fs.unlinkSync(file);
		} catch {
			// Unreadable record: the client ignores it too.
		}
	}
}

function isInside(root: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(candidate));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Text of a regular file, or undefined when it is missing, binary, or oversized. */
function readSnapshot(file: string): string | undefined {
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) return undefined;
		const bytes = fs.readFileSync(file);
		if (bytes.includes(0)) return undefined;
		return bytes.toString("utf8");
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI): void {
	let endpoint: Endpoint | undefined;
	let server: net.Server | undefined;
	let heartbeat: NodeJS.Timeout | undefined;
	const clients = new Set<net.Socket>();
	const pendingApprovals = new Map<string, (allow: boolean) => void>();
	const pendingRpc = new Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>();
	const clientCapabilities = new Map<net.Socket, Set<string>>();
	const features = ["context.snapshot", "approval", "tools", "revert"];
	const snapshots = new Map<string, Snapshot>();

	const send = (socket: net.Socket, message: Record<string, unknown>): void => {
		if (!socket.destroyed) socket.write(encode(message));
	};

	const broadcast = (message: Record<string, unknown>): void => {
		for (const socket of clients) send(socket, message);
	};

	/** Asks the VS Code window to run an editor-side operation. */
	const supports = (capability: string): boolean => {
		for (const capabilities of clientCapabilities.values()) if (capabilities.has(capability)) return true;
		return false;
	};

	const callWindow = (method: string, params: Record<string, unknown> = {}, timeoutMs = RPC_TIMEOUT_MS): Promise<string> => {
		if (clients.size === 0) {
			return Promise.reject(new Error("No VS Code window is connected. Start omp inside a VS Code terminal."));
		}
		const id = crypto.randomUUID();
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		const timer = setTimeout(() => {
			if (!pendingRpc.delete(id)) return;
			reject(new Error(`VS Code did not answer ${method} within ${timeoutMs / 1000}s`));
		}, timeoutMs);
		pendingRpc.set(id, {
			resolve: value => {
				clearTimeout(timer);
				pendingRpc.delete(id);
				resolve(value);
			},
			reject: error => {
				clearTimeout(timer);
				pendingRpc.delete(id);
				reject(error);
			},
		});
		broadcast({ type: "rpc_request", id, method, params });
		return promise;
	};

	const writeRecord = (): void => {
		if (!endpoint) return;
		const record: EndpointRecord = {
			protocol: PROTOCOL_VERSION,
			pid: process.pid,
			parentPid: process.ppid,
			port: endpoint.port,
			sessionId: endpoint.sessionId,
			cwd: endpoint.cwd,
			token: endpoint.token,
			startedAt: endpoint.startedAt,
			updatedAt: new Date().toISOString(),
			ancestorPids: ancestorPids(process.ppid),
		};
		fs.mkdirSync(ENDPOINT_DIR, { recursive: true });
		const temp = `${endpoint.recordPath}.${process.pid}.tmp`;
		fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
		fs.renameSync(temp, endpoint.recordPath);
	};

	const stop = (): void => {
		clearInterval(heartbeat);
		heartbeat = undefined;
		for (const resolve of pendingApprovals.values()) resolve(false);
		pendingApprovals.clear();
		for (const pending of pendingRpc.values()) pending.reject(new Error("bridge stopped"));
		pendingRpc.clear();
		for (const socket of clients) socket.destroy();
		clients.clear();
		server?.close();
		server = undefined;
		if (endpoint) {
			try {
				fs.unlinkSync(endpoint.recordPath);
			} catch {
				// Already gone.
			}
		}
		endpoint = undefined;
	};

	const publishSession = (sessionId: string, sessionFile?: string): void => {
		if (!endpoint) return;
		endpoint.sessionId = sessionId;
		endpoint.sessionFile = sessionFile;
		writeRecord();
		broadcast({ type: "session_update", sessionId, cwd: endpoint.cwd, sessionFile });
	};

	/** Asks every connected window; the first answer wins, a timeout allows the tool. */
	const requestApproval = (tool: string, file: string, proposed?: string): Promise<boolean> => {
		if (clients.size === 0) return Promise.resolve(true);
		const requestId = crypto.randomUUID();
		const { promise, resolve } = Promise.withResolvers<boolean>();
		const timer = setTimeout(() => {
			if (!pendingApprovals.delete(requestId)) return;
			pi.logger.warn("bridge: approval timed out, allowing", { file });
			resolve(true);
		}, APPROVAL_TIMEOUT_MS);
		pendingApprovals.set(requestId, allow => {
			clearTimeout(timer);
			pendingApprovals.delete(requestId);
			resolve(allow);
		});
		broadcast({
			type: "approval_request",
			requestId,
			tool,
			path: file,
			cwd: endpoint?.cwd,
			timestamp: new Date().toISOString(),
			proposed,
		});
		return promise;
	};

	const start = (cwd: string, sessionId: string, sessionFile?: string): void => {
		if (server) {
			publishSession(sessionId, sessionFile);
			return;
		}
		const token = crypto.randomBytes(16).toString("hex");
		const draft: Endpoint = {
			protocol: PROTOCOL_VERSION,
			pid: process.pid,
			parentPid: process.ppid,
			port: 0,
			sessionId,
			cwd: path.resolve(cwd),
			token,
			startedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			ancestorPids: [],
			recordPath: "",
		};
		endpoint = draft;

		const tcp = net.createServer(socket => {
			clients.add(socket);
			socket.setNoDelay(true);
			let pending = "";
			socket.on("data", chunk => {
				pending += chunk.toString("utf8");
				if (Buffer.byteLength(pending, "utf8") > MAX_CONTEXT_BYTES) {
					pending = "";
					return;
				}
				let newline = pending.indexOf("\n");
				while (newline >= 0) {
					const line = pending.slice(0, newline).trim();
					pending = pending.slice(newline + 1);
					newline = pending.indexOf("\n");
					if (!line) continue;
					let message: Record<string, unknown>;
					try {
						message = JSON.parse(line);
					} catch {
						continue;
					}
					switch (message.type) {
						case "register": {
							if (message.token !== token || !endpoint) {
								send(socket, { type: "error", code: "unauthorized", message: "Invalid bridge token" });
								socket.destroy();
								return;
							}
							clientCapabilities.set(
								socket,
								new Set(Array.isArray(message.capabilities) ? message.capabilities.filter(c => typeof c === "string") : []),
							);
							send(socket, {
								type: "register_ack",
								sessionId: endpoint.sessionId,
								cwd: endpoint.cwd,
								sessionFile: endpoint.sessionFile,
								serverPid: process.pid,
								serverPort: endpoint.port,
								features,
							});
							pi.logger.debug("bridge: VS Code client registered", { windowId: message.windowId });
							break;
						}
						case "approval_response": {
							const requestId = typeof message.requestId === "string" ? message.requestId : "";
							const resolve = pendingApprovals.get(requestId);
							if (!resolve) break;
							pi.logger.debug("bridge: approval answered", { requestId, allow: message.allow === true });
							resolve(message.allow === true);
							break;
						}
						case "rpc_response": {
							const id = typeof message.id === "string" ? message.id : "";
							const pending = pendingRpc.get(id);
							if (!pending) break;
							if (message.ok === true) pending.resolve(typeof message.result === "string" ? message.result : "");
							else pending.reject(new Error(typeof message.error === "string" ? message.error : "VS Code reported an unknown error"));
							break;
						}
						case "context": {
							const text = typeof message.text === "string" ? message.text : "";
							if (!text) {
								send(socket, { type: "context_result", ok: false, message: "empty context" });
								break;
							}
							try {
								if (message.insertOnly === true) {
									pi.sendMessage({ customType: "ide-context", content: text, display: false }, { triggerTurn: false });
								} else {
									pi.sendUserMessage(text, { deliverAs: "aside" });
								}
								send(socket, { type: "context_result", ok: true });
							} catch (error) {
								send(socket, {
									type: "context_result",
									ok: false,
									message: error instanceof Error ? error.message : String(error),
								});
							}
							break;
						}
						default:
							break;
					}
				}
			});
			socket.on("error", error => pi.logger.debug("bridge: client socket error", { error: String(error) }));
			socket.on("close", () => {
				clients.delete(socket);
				clientCapabilities.delete(socket);
			});
		});

		tcp.on("error", error => pi.logger.warn("bridge: server error", { error: String(error) }));

		tcp.listen(0, "127.0.0.1", () => {
			const address = tcp.address();
			if (!address || typeof address === "string" || !endpoint) {
				stop();
				return;
			}
			draft.port = address.port;
			draft.recordPath = path.join(ENDPOINT_DIR, `omp-${process.pid}-${address.port}.json`);
			server = tcp;
			sweepStaleRecords(process.pid);
			writeRecord();
			pi.logger.debug("bridge: endpoint published", { port: address.port, cwd: draft.cwd });
			heartbeat = setInterval(() => {
				writeRecord();
				broadcast({ type: "ping" });
			}, HEARTBEAT_MS);
			heartbeat.unref?.();
		});
	};

	const z = pi.zod;
	const asText = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

	/** Tools that reach into the connected VS Code window. */
	const registerWindowTools = (): void => {
		pi.registerTool({
			name: "vscode_tools",
			label: "VS Code tools",
			description:
				"List the language-model tools the connected VS Code window can run, including MCP servers VS Code manages and Copilot tools. Call this before vscode_tool.",
			parameters: z.object({}),
			async execute() {
				return asText(await callWindow("lm.list"));
			},
		});

		pi.registerTool({
			name: "vscode_tool",
			label: "VS Code tool",
			description:
				"Run one of the tools listed by vscode_tools inside VS Code, with its own consent prompts. Pass input as a JSON object string matching that tool's schema.",
			parameters: z.object({
				name: z.string().describe("Tool name from vscode_tools"),
				input: z.string().optional().describe('JSON object string of tool arguments, e.g. {"query":"foo"}'),
			}),
			async execute(_toolCallId: string, params: { name: string; input?: string }) {
				return asText(await callWindow("lm.invoke", { name: params.name, input: params.input ?? "{}" }));
			},
		});

		pi.registerTool({
			name: "vscode_diagnostics",
			label: "VS Code diagnostics",
			description: "Errors and warnings the connected VS Code window reports, for one file or the workspace.",
			parameters: z.object({
				path: z.string().optional().describe("Absolute file path; omit for the whole workspace"),
				severity: z.enum(["all", "errors"]).optional().describe("Filter, defaults to all"),
			}),
			async execute(_toolCallId: string, params: { path?: string; severity?: "all" | "errors" }) {
				return asText(await callWindow("diagnostics", { path: params.path, severity: params.severity ?? "all" }));
			},
		});

		pi.registerTool({
			name: "vscode_command",
			label: "VS Code command",
			description:
				"Run a VS Code command by id. Only ids allowlisted in the ompBridge.allowedCommands setting are accepted; the user confirms each call in the window.",
			parameters: z.object({
				command: z.string().describe("Command id, e.g. editor.action.organizeImports"),
				args: z.string().optional().describe("JSON array string of arguments"),
			}),
			async execute(_toolCallId: string, params: { command: string; args?: string }) {
				let args: unknown[] = [];
				if (params.args) {
					try {
						const parsed = JSON.parse(params.args);
						if (!Array.isArray(parsed)) throw new Error("args must be a JSON array");
						args = parsed;
					} catch (error) {
						throw new Error(`args is not a JSON array: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
				return asText(await callWindow("command", { command: params.command, args }));
			},
		});

		pi.registerTool({
			name: "vscode_debug",
			label: "VS Code debugger",
			description: "Start a launch.json configuration or stop the active debug session in the connected VS Code window.",
			parameters: z.object({
				action: z.enum(["start", "stop"]).optional().describe("Defaults to start"),
				name: z.string().optional().describe("Launch configuration name, required for start"),
			}),
			async execute(_toolCallId: string, params: { action?: "start" | "stop"; name?: string }) {
				return asText(await callWindow("debug", { action: params.action ?? "start", name: params.name }));
			},
		});

		pi.registerTool({
			name: "vscode_task",
			label: "VS Code tasks",
			description: "List or start VS Code tasks defined in tasks.json for the connected window.",
			parameters: z.object({
				action: z.enum(["list", "run"]).optional().describe("Defaults to list"),
				name: z.string().optional().describe("Task name, required for run"),
			}),
			async execute(_toolCallId: string, params: { action?: "list" | "run"; name?: string }) {
				return asText(await callWindow("task", { action: params.action ?? "list", name: params.name }));
			},
		});
	};

	registerWindowTools();

	const sessionInfo = (ctx: {
		cwd: string;
		sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
	}) => ({
		cwd: ctx.cwd,
		sessionId: ctx.sessionManager.getSessionId(),
		sessionFile: ctx.sessionManager.getSessionFile(),
	});

	/** Resolves the path an edit/write tool is about to touch, if the bridge can surface it. */
	const targetOf = (input: Record<string, unknown>): string | undefined => {
		if (!endpoint) return undefined;
		const rawPath = input.path ?? input.file_path;
		// `write` also backs omp's virtual devices (xd://, local://): not files VS Code can open.
		if (typeof rawPath !== "string" || !rawPath || rawPath.includes("://")) return undefined;
		const resolved = path.resolve(endpoint.cwd, rawPath);
		return isInside(endpoint.cwd, resolved) ? resolved : undefined;
	};

	pi.on("tool_call", async event => {
		if (!endpoint) return;
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const file = targetOf(event.input);
		if (!file) return;
		const before = readSnapshot(file);
		snapshots.set(file, before === undefined ? { created: !fs.existsSync(file) } : { previous: before });
		const proposed = event.toolName === "write" && typeof event.input.content === "string" ? event.input.content : undefined;
		const allow = await requestApproval(event.toolName, file, proposed);
		if (allow) return;
		snapshots.delete(file);
		return { block: true, reason: "Denied by the user in VS Code" };
	});

	pi.on("tool_result", event => {
		if (!endpoint) return;
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		if (event.isError) return;
		const file = targetOf(event.input);
		if (!file || !fs.existsSync(file)) return;
		const snapshot = snapshots.get(file);
		snapshots.delete(file);
		broadcast({
			type: "file_edited",
			sessionId: endpoint.sessionId,
			path: file,
			tool: event.toolName,
			cwd: endpoint.cwd,
			timestamp: new Date().toISOString(),
			previous: snapshot?.previous,
			created: snapshot?.created,
		});
	});

	pi.on("before_agent_start", async () => {
		if (!endpoint || clients.size === 0 || !supports("context.snapshot")) return;
		try {
			const snapshot = (await callWindow("context.snapshot", {}, 2000)).trim();
			if (!snapshot) return;
			return {
				message: { customType: "ide-context", content: `<ide-context>\n${snapshot}\n</ide-context>`, display: false },
			};
		} catch (error) {
			pi.logger.debug("bridge: context snapshot unavailable", { error: String(error) });
			return;
		}
	});

	pi.on("session_start", (_event, ctx) => {
		const info = sessionInfo(ctx);
		start(info.cwd, info.sessionId, info.sessionFile);
	});

	pi.on("session_switch", (_event, ctx) => {
		const info = sessionInfo(ctx);
		publishSession(info.sessionId, info.sessionFile);
	});

	pi.on("session_shutdown", () => stop());
}
