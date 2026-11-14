/**
 * One persistent connection per matched endpoint: register, answer pings,
 * route edits and approval requests to the window, reconnect with backoff.
 */
import * as net from "node:net";
import type * as vscode from "vscode";
import {
	type ContextKind,
	type EndpointRecord,
	JsonLineDecoder,
	type ServerMessage,
	encode,
	parseServerMessage,
} from "../protocol";

export type ConnectionState = "connecting" | "connected" | "disconnected";

export interface SessionSnapshot {
	state: ConnectionState;
	endpoint: EndpointRecord;
	terminalName: string;
	sessionId?: string;
	sessionFile?: string;
	cwd: string;
	edits: number;
}

export interface ConnectionHandlers {
	onChanged(): void;
	onFileEdited(message: Extract<ServerMessage, { type: "file_edited" }>): void;
	onApprovalRequest(message: Extract<ServerMessage, { type: "approval_request" }>): void;
	onContextResult(message: Extract<ServerMessage, { type: "context_result" }>): void;
	onRpcRequest(message: Extract<ServerMessage, { type: "rpc_request" }>): Promise<string>;
}

const MAX_BACKOFF_MS = 10_000;

export class EndpointConnection {
	private socket?: net.Socket;
	private stopped = false;
	private attempt = 0;
	private reconnectTimer?: NodeJS.Timeout;
	private readonly decoder = new JsonLineDecoder();
	private roots: string[];
	private snapshot: SessionSnapshot;

	constructor(
		private readonly windowId: string,
		private endpoint: EndpointRecord,
		private terminal: vscode.Terminal | undefined,
		roots: string[],
		private readonly handlers: ConnectionHandlers,
		private readonly log: (message: string) => void,
	) {
		this.roots = [...roots];
		this.snapshot = this.buildSnapshot("disconnected");
	}

	get info(): SessionSnapshot {
		return this.snapshot;
	}

	get connected(): boolean {
		return this.snapshot.state === "connected" && !this.socket?.destroyed;
	}

	update(endpoint: EndpointRecord, terminal: vscode.Terminal | undefined, roots: string[]): void {
		const moved =
			endpoint.port !== this.endpoint.port || endpoint.token !== this.endpoint.token || endpoint.pid !== this.endpoint.pid;
		this.endpoint = endpoint;
		this.terminal = terminal;
		this.roots = [...roots];
		this.snapshot = this.buildSnapshot(this.snapshot.state);
		this.handlers.onChanged();
		if (moved) {
			this.attempt = 0;
			this.socket?.destroy();
			this.socket = undefined;
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		this.connect();
	}

	private buildSnapshot(state: ConnectionState): SessionSnapshot {
		return {
			state,
			endpoint: this.endpoint,
			terminalName: this.terminal?.name ?? "pinned",
			sessionId: this.snapshot?.sessionId,
			sessionFile: this.snapshot?.sessionFile,
			cwd: this.endpoint.cwd,
			edits: this.snapshot?.edits ?? 0,
		};
	}

	connect(): void {
		if (this.stopped || this.socket) return;
		this.snapshot = this.buildSnapshot("connecting");
		this.handlers.onChanged();
		const socket = net.createConnection(this.endpoint.port, "127.0.0.1");
		this.socket = socket;
		socket.setNoDelay(true);
		socket.setKeepAlive(true, 10_000);

		socket.on("connect", () => {
			this.attempt = 0;
			socket.write(
				encode({
					type: "register",
					token: this.endpoint.token,
					clientId: `${this.windowId}:${this.endpoint.pid}`,
					windowId: this.windowId,
					terminalName: this.terminal?.name ?? "pinned",
					workspaceRoots: this.roots,
					capabilities: ["context.snapshot", "approval", "tools", "revert"],
				}),
			);
		});

		socket.on("data", chunk => {
			for (const raw of this.decoder.push(chunk)) this.handle(raw);
		});

		socket.on("error", error => this.log(`socket to ${this.endpoint.pid} failed: ${error.message}`));

		socket.on("close", () => {
			if (this.socket === socket) this.socket = undefined;
			this.snapshot = this.buildSnapshot("disconnected");
			this.handlers.onChanged();
			this.scheduleReconnect();
		});
	}

	sendContext(kind: ContextKind, text: string, insertOnly = false): boolean {
		if (!this.socket || this.snapshot.state !== "connected") return false;
		this.socket.write(encode({ type: "context", kind, text, insertOnly, cwd: this.snapshot.cwd }));
		return true;
	}

	respondToApproval(requestId: string, allow: boolean, reason?: string): void {
		this.socket?.write(encode({ type: "approval_response", requestId, allow, reason }));
	}

	private handle(raw: unknown): void {
		const message = parseServerMessage(raw);
		if (!message) {
			this.log(`discarded malformed message from ${this.endpoint.pid}`);
			return;
		}
		switch (message.type) {
			case "ping":
				this.socket?.write(`${JSON.stringify({ type: "pong" })}\n`);
				return;
			case "register_ack":
				this.snapshot = {
					...this.buildSnapshot("connected"),
					sessionId: message.sessionId,
					sessionFile: message.sessionFile,
					cwd: message.cwd,
				};
				this.log(`connected: session ${message.sessionId} (pid ${message.serverPid})`);
				this.handlers.onChanged();
				return;
			case "session_update":
				this.snapshot = {
					...this.snapshot,
					sessionId: message.sessionId,
					sessionFile: message.sessionFile,
					cwd: message.cwd,
				};
				this.log(`session switched: ${message.sessionId}`);
				this.handlers.onChanged();
				return;
			case "file_edited":
				this.snapshot = { ...this.snapshot, edits: this.snapshot.edits + 1 };
				this.handlers.onFileEdited(message);
				return;
			case "approval_request":
				this.handlers.onApprovalRequest(message);
				return;
			case "context_result":
				this.handlers.onContextResult(message);
				return;
			case "rpc_request":
				void this.handlers.onRpcRequest(message).then(
					result =>
						this.socket?.write(encode({ type: "rpc_response", id: message.id, ok: true, result })),
					error =>
						this.socket?.write(
							encode({
								type: "rpc_response",
								id: message.id,
								ok: false,
								error: error instanceof Error ? error.message : String(error),
							}),
						),
				);
				return;
			case "error":
				this.log(`server error ${message.code}: ${message.message}`);
				return;
		}
	}

	private scheduleReconnect(): void {
		if (this.stopped || this.reconnectTimer) return;
		const delay = Math.min(1000 * 2 ** this.attempt, MAX_BACKOFF_MS);
		this.attempt++;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			this.connect();
		}, delay);
	}

	dispose(): void {
		this.stopped = true;
		clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		this.socket?.destroy();
		this.socket = undefined;
		this.snapshot = this.buildSnapshot("disconnected");
	}
}
