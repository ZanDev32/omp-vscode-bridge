/**
 * Wire protocol shared by the VS Code client and the OMP server.
 *
 * One loopback TCP connection per omp process, newline-delimited JSON.
 * The server authenticates the client with the token from its endpoint record.
 */
import * as path from "node:path";

export const PROTOCOL_VERSION = 4;
export const MAX_LINE_BYTES = 1024 * 1024;

export interface EndpointRecord {
	protocol: number;
	pid: number;
	parentPid: number;
	port: number;
	sessionId: string;
	cwd: string;
	token: string;
	startedAt: string;
	updatedAt: string;
	ancestorPids: number[];
}

export type ContextKind = "selection" | "file" | "problems";

export interface RegisterMessage {
	type: "register";
	protocol: number;
	token: string;
	clientId: string;
	windowId: string;
	terminalPid?: number;
	terminalName?: string;
	workspaceRoots: string[];
	/** Client abilities, e.g. "context.snapshot", "approval", "tools". */
	capabilities: string[];
}

export type FileTool = "edit" | "write";

export type ServerMessage =
	| {
			type: "register_ack";
			sessionId: string;
			cwd: string;
			sessionFile?: string;
			serverPid: number;
			serverPort: number;
			/** Server abilities, e.g. "context.snapshot", "approval", "tools". */
			features?: string[];
	  }
	| { type: "session_update"; sessionId: string; cwd: string; sessionFile?: string }
	| {
			type: "file_edited";
			sessionId: string;
			path: string;
			cwd: string;
			tool: FileTool;
			timestamp: string;
			/** File text before the tool ran; absent when it was unreadable or too large. */
			previous?: string;
			/** True when the file did not exist before the tool ran. */
			created?: boolean;
	  }
	| {
			type: "approval_request";
			requestId: string;
			tool: FileTool;
			path: string;
			cwd: string;
			timestamp: string;
			/** Full proposed text, present for `write`. */
			proposed?: string;
	  }
	| { type: "context_result"; ok: boolean; message?: string }
	| { type: "rpc_request"; id: string; method: string; params: Record<string, unknown> }
	| { type: "ping" }
	| { type: "error"; code: string; message: string };

export function encode(message: Record<string, unknown>): string {
	return `${JSON.stringify({ protocol: PROTOCOL_VERSION, ...message })}\n`;
}

/** Splits a byte stream into complete JSON lines; oversized buffering is dropped. */
export class JsonLineDecoder {
	private buffer = "";

	push(chunk: string | Buffer): unknown[] {
		this.buffer += chunk.toString();
		if (Buffer.byteLength(this.buffer, "utf8") > MAX_LINE_BYTES) {
			this.buffer = "";
			return [];
		}
		const messages: unknown[] = [];
		let newline = this.buffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			newline = this.buffer.indexOf("\n");
			if (!line.trim()) continue;
			try {
				messages.push(JSON.parse(line));
			} catch {
				// Malformed frame: keep the connection, drop the line.
			}
		}
		return messages;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function readInteger(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
	const value = record[key];
	if (!Array.isArray(value)) return undefined;
	const strings = value.filter((item): item is string => typeof item === "string" && item.length > 0);
	return strings.length === value.length ? strings : undefined;
}

function readIntegerArray(record: Record<string, unknown>, key: string): number[] | undefined {
	const value = record[key];
	if (!Array.isArray(value)) return undefined;
	const numbers = value.filter((item): item is number => typeof item === "number" && Number.isInteger(item) && item > 0);
	return numbers.length === value.length ? numbers : undefined;
}

export function parseEndpointRecord(value: unknown): EndpointRecord | undefined {
	if (!isRecord(value) || value.protocol !== PROTOCOL_VERSION) return undefined;
	const pid = readInteger(value, "pid");
	const parentPid = readInteger(value, "parentPid");
	const port = readInteger(value, "port");
	const sessionId = readString(value, "sessionId");
	const cwd = readString(value, "cwd");
	const token = readString(value, "token");
	const startedAt = readString(value, "startedAt");
	const updatedAt = readString(value, "updatedAt");
	const ancestorPids = readIntegerArray(value, "ancestorPids");
	if (!pid || !parentPid || !port || !sessionId || !cwd || !token || !startedAt || !updatedAt || !ancestorPids) {
		return undefined;
	}
	return { protocol: PROTOCOL_VERSION, pid, parentPid, port, sessionId, cwd, token, startedAt, updatedAt, ancestorPids };
}

export function parseServerMessage(value: unknown): ServerMessage | undefined {
	if (!isRecord(value) || value.protocol !== PROTOCOL_VERSION || typeof value.type !== "string") return undefined;
	switch (value.type) {
		case "ping":
			return { type: "ping" };
		case "error": {
			const code = readString(value, "code");
			const message = readString(value, "message");
			return code && message ? { type: "error", code, message } : undefined;
		}
		case "register_ack": {
			const sessionId = readString(value, "sessionId");
			const cwd = readString(value, "cwd");
			const serverPid = readInteger(value, "serverPid");
			const serverPort = readInteger(value, "serverPort");
			if (!sessionId || !cwd || !serverPid || !serverPort) return undefined;
			const features = readStringArray(value, "features");
			return {
				type: "register_ack",
				sessionId,
				cwd,
				sessionFile: readOptionalString(value, "sessionFile"),
				serverPid,
				serverPort,
				features,
			};
		}
		case "session_update": {
			const sessionId = readString(value, "sessionId");
			const cwd = readString(value, "cwd");
			if (!sessionId || !cwd) return undefined;
			return { type: "session_update", sessionId, cwd, sessionFile: readOptionalString(value, "sessionFile") };
		}
		case "file_edited": {
			const sessionId = readString(value, "sessionId");
			const filePath = readString(value, "path");
			const cwd = readString(value, "cwd");
			const timestamp = readString(value, "timestamp");
			const tool = value.tool;
			if (!sessionId || !filePath || !cwd || !timestamp) return undefined;
			if (tool !== "edit" && tool !== "write") return undefined;
			return {
				type: "file_edited",
				sessionId,
				path: path.resolve(filePath),
				cwd: path.resolve(cwd),
				tool,
				timestamp,
				previous: readOptionalString(value, "previous"),
				created: value.created === true ? true : undefined,
			};
		}
		case "approval_request": {
			const requestId = readString(value, "requestId");
			const filePath = readString(value, "path");
			const cwd = readString(value, "cwd");
			const timestamp = readString(value, "timestamp");
			const tool = value.tool;
			if (!requestId || !filePath || !cwd || !timestamp) return undefined;
			if (tool !== "edit" && tool !== "write") return undefined;
			return {
				type: "approval_request",
				requestId,
				tool,
				path: path.resolve(filePath),
				cwd: path.resolve(cwd),
				timestamp,
				proposed: readOptionalString(value, "proposed"),
			};
		}
		case "rpc_request": {
			const id = readString(value, "id");
			const method = readString(value, "method");
			if (!id || !method) return undefined;
			const params = isRecord(value.params) ? value.params : {};
			return { type: "rpc_request", id, method, params };
		}
		case "context_result": {
			const ok = value.ok;
			if (typeof ok !== "boolean") return undefined;
			return { type: "context_result", ok, message: readOptionalString(value, "message") };
		}
		default:
			return undefined;
	}
}

export function isPathInside(root: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(candidate));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
