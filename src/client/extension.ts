/**
 * VS Code side of the OMP bridge.
 *
 * Discovers omp endpoints, keeps one connection per matching terminal, and
 * surfaces agent activity with native editor affordances only: diffs, modal
 * approval prompts, a status bar counter, and a tree view of recent edits.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { EndpointRecord, ServerMessage } from "../protocol";
import { forgetApprovals, isAutoApproved, rememberApproval } from "./approvals";
import { EndpointConnection, type SessionSnapshot } from "./connection";
import {
	type ContextPayload,
	type DiffScope,
	diffContext,
	openTabsContext,
	pickFilesContext,
	problemsContext,
	readForContext,
	selectionContext,
	symbolContext,
} from "./context";
import { discoverMatches, readEndpoints } from "./discovery";
import { EditHistory, revert } from "./history";
import { PROPOSED_SCHEME, SCHEME, clearProposal, headProvider, proposedProvider, showProposal, surfaceEdit } from "./open-edits";
import { handleRpc } from "./rpc";

const SCAN_INTERVAL_MS = 2000;
const TREE_VIEW_ID = "ompBridge.recentEdits";
const PINNED_KEY = "ompBridge.pinned";

const globCache = new Map<string, RegExp>();

function globToRegExp(pattern: string): RegExp {
	const cached = globCache.get(pattern);
	if (cached) return cached;
	const source = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "\u0000")
		.replace(/\*/g, "[^/]*")
		.replace(/\u0000/g, ".*");
	const compiled = new RegExp(`^${source}$`);
	globCache.set(pattern, compiled);
	return compiled;
}

type FileEdited = Extract<ServerMessage, { type: "file_edited" }>;
type ApprovalRequest = Extract<ServerMessage, { type: "approval_request" }>;

class BridgeManager implements vscode.Disposable {
	private readonly windowId = crypto.randomUUID();
	private readonly connections = new Map<string, EndpointConnection>();
	private readonly disposables: vscode.Disposable[] = [];
	private scanTimer?: NodeJS.Timeout;
	private scanning = false;

	constructor(
		private readonly log: (message: string) => void,
		private readonly onFileEdited: (message: FileEdited) => void,
		private readonly onApprovalRequest: (message: ApprovalRequest, connection: EndpointConnection) => void,
		private readonly onSessionsChanged: (sessions: SessionSnapshot[]) => void,
		private readonly pinned: () => string | undefined,
	) {
		this.scanTimer = setInterval(() => void this.scan(), SCAN_INTERVAL_MS);
		void this.scan();
		this.disposables.push(
			vscode.window.onDidCloseTerminal(() => this.emit()),
			vscode.workspace.onDidChangeWorkspaceFolders(() => void this.scan()),
		);
	}

	get sessions(): SessionSnapshot[] {
		return [...this.connections.values()].map(connection => connection.info);
	}

	get ready(): EndpointConnection[] {
		return [...this.connections.values()].filter(connection => connection.connected);
	}

	private get roots(): string[] {
		return (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
	}

	private async scan(): Promise<void> {
		if (this.scanning) return;
		this.scanning = true;
		try {
			const roots = this.roots;
			const seen = new Set<string>();
			for (const { endpoint, terminal } of await discoverMatches(roots)) {
				const key = `${endpoint.pid}:${endpoint.port}`;
				seen.add(key);
				this.bind(key, endpoint, terminal, roots);
			}
			// A pinned endpoint stays bound even when terminal matching cannot see it.
			const pinnedKey = this.pinned();
			if (pinnedKey && !seen.has(pinnedKey)) {
				const endpoint = readEndpoints().find(candidate => `${candidate.pid}:${candidate.port}` === pinnedKey);
				if (endpoint) {
					seen.add(pinnedKey);
					this.bind(pinnedKey, endpoint, undefined, roots);
				}
			}
			for (const [key, connection] of this.connections) {
				if (seen.has(key)) continue;
				connection.dispose();
				this.connections.delete(key);
			}
		} catch (error) {
			this.log(`scan failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.scanning = false;
			this.emit();
		}
	}

	private bind(key: string, endpoint: EndpointRecord, terminal: vscode.Terminal | undefined, roots: string[]): void {
		const existing = this.connections.get(key);
		if (existing) {
			existing.update(endpoint, terminal, roots);
			return;
		}
		const connection = new EndpointConnection(
			this.windowId,
			endpoint,
			terminal,
			roots,
			{
				onChanged: () => this.emit(),
				onFileEdited: message => this.onFileEdited(message),
				onApprovalRequest: message => this.onApprovalRequest(message, connection),
				onRpcRequest: message => {
					this.log(`rpc ${message.method} from omp`);
					return handleRpc(message.method, message.params);
				},
				onContextResult: message => {
					this.log(`context ${message.ok ? "delivered" : "failed"}${message.message ? `: ${message.message}` : ""}`);
					if (!message.ok) {
						void vscode.window.showWarningMessage(`OMP Bridge: ${message.message ?? "context not delivered"}`);
					}
				},
			},
			this.log,
		);
		this.connections.set(key, connection);
		connection.connect();
	}

	private emit(): void {
		this.onSessionsChanged(this.sessions);
	}

	dispose(): void {
		clearInterval(this.scanTimer);
		this.scanTimer = undefined;
		for (const disposable of this.disposables.splice(0)) disposable.dispose();
		for (const connection of this.connections.values()) connection.dispose();
		this.connections.clear();
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel("OMP Bridge");
	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	const history = new EditHistory();
	const state = context.workspaceState;
	const log = (message: string): void => output.appendLine(`[${new Date().toISOString()}] ${message}`);

	const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration("ompBridge");
	const ignored = (file: string): boolean => {
		const patterns = config().get<string[]>("ignoredPaths", []);
		const relative = vscode.workspace.asRelativePath(file, false).split(path.sep).join("/");
		return patterns.some(pattern => globToRegExp(pattern).test(relative) || globToRegExp(pattern).test(file));
	};

	const pickConnection = async (): Promise<EndpointConnection | undefined> => {
		const ready = manager.ready;
		if (ready.length === 0) {
			void vscode.window.showWarningMessage("OMP Bridge: no connected omp session.");
			return undefined;
		}
		if (ready.length === 1) return ready[0];
		const choice = await vscode.window.showQuickPick(
			ready.map(connection => ({
				label: connection.info.cwd,
				description: `pid ${connection.info.endpoint.pid}`,
				connection,
			})),
			{ title: "Send to which omp session?" },
		);
		return choice?.connection;
	};

	const surface = async (message: FileEdited): Promise<void> => {
		if (ignored(message.path)) {
			log(`ignored ${message.path} (ompBridge.ignoredPaths)`);
			return;
		}
		let surfaced = "logged";
		if (config().get<boolean>("autoOpen", true)) surfaced = await surfaceEdit(message.path);
		history.add({
			sessionId: message.sessionId,
			path: message.path,
			tool: message.tool,
			at: message.timestamp,
			previous: message.previous,
			created: message.created,
			surfaced,
		});
	};

	const askApproval = async (message: ApprovalRequest, connection: EndpointConnection): Promise<void> => {
		try {
			if (isAutoApproved(state, message.tool, message.path)) {
				log(`auto-approved ${message.tool} ${message.path}`);
				connection.respondToApproval(message.requestId, true);
				return;
			}
			if (!config().get<boolean>("requireApproval", true)) {
				connection.respondToApproval(message.requestId, true);
				return;
			}
			log(`approval requested: ${message.tool} ${message.path}`);
			if (message.proposed !== undefined && config().get<boolean>("showDiffs", true)) {
				await showProposal(message.requestId, message.path, message.proposed, fs.existsSync(message.path));
			}
			const choice = await vscode.window.showInformationMessage(
				`OMP wants to ${message.tool}: ${vscode.workspace.asRelativePath(message.path, false)}`,
				{
					modal: true,
					detail: `Allowing lets the agent write the file. Denying returns an error to the agent.\n\n${message.path}`,
				},
				"Allow",
				"Always Allow",
				"Deny",
			);
			if (choice === "Always Allow") await rememberApproval(state, message.tool, message.path);
			const allow = choice === "Allow" || choice === "Always Allow";
			connection.respondToApproval(message.requestId, allow, allow ? undefined : "Denied by the VS Code window");
		} catch (error) {
			log(`approval failed: ${error instanceof Error ? error.message : String(error)}`);
			connection.respondToApproval(message.requestId, false, "Approval prompt failed in VS Code");
		} finally {
			clearProposal(message.requestId);
		}
	};

	const render = (sessions: SessionSnapshot[]): void => {
		const connected = sessions.filter(session => session.state === "connected").length;
		status.text = sessions.length === 0 ? "$(plug) OMP Bridge: 0 sessions" : `$(plug) OMP Bridge: ${connected}/${sessions.length}`;
		status.tooltip = sessions.length
			? sessions
					.map(session => `${session.state} · ${session.cwd} · pid ${session.endpoint.pid} · ${session.edits} edits`)
					.join("\n")
			: "No OMP endpoints found under ~/.omp-vscode/servers";
		status.command = "ompBridge.showSessions";
		status.show();
	};

	const manager = new BridgeManager(
		log,
		message => void surface(message),
		(message, connection) => void askApproval(message, connection),
		render,
		() => state.get<string>(PINNED_KEY),
	);

	const sendContext = async (payload: ContextPayload | undefined): Promise<void> => {
		if (!payload) {
			void vscode.window.showInformationMessage("OMP Bridge: nothing to send.");
			return;
		}
		const connection = await pickConnection();
		if (!connection) return;
		const insertOnly = config().get<string>("contextDelivery", "aside") === "queue";
		if (!connection.sendContext(payload.kind, payload.text, insertOnly)) {
			void vscode.window.showWarningMessage("OMP Bridge: session is not connected.");
			return;
		}
		log(`sent ${payload.kind} context (${payload.text.length} chars, ${insertOnly ? "queued" : "aside"})`);
	};

	const revertEdit = async (id?: string): Promise<void> => {
		const record = id ? history.get(id) : history.list()[0];
		if (!record) {
			void vscode.window.showInformationMessage("OMP Bridge: no edits to revert.");
			return;
		}
		const confirmation = await vscode.window.showWarningMessage(
			`Revert ${record.created ? "creation of" : "edits to"} ${vscode.workspace.asRelativePath(record.path, false)}?`,
			{ modal: true },
			"Revert",
		);
		if (confirmation !== "Revert") return;
		try {
			await revert(record);
			history.fire();
			log(`reverted ${record.path}`);
		} catch (error) {
			void vscode.window.showErrorMessage(`OMP Bridge: revert failed — ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	context.subscriptions.push(
		output,
		status,
		manager,
		vscode.window.registerTreeDataProvider(TREE_VIEW_ID, history),
		vscode.workspace.registerTextDocumentContentProvider(SCHEME, headProvider),
		vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, proposedProvider),
		vscode.commands.registerCommand("ompBridge.showLogFile", () => output.show(true)),
		vscode.commands.registerCommand("ompBridge.showSessions", async () => {
			const sessions = manager.sessions;
			if (sessions.length === 0) {
				await vscode.window.showInformationMessage("OMP Bridge: no sessions detected. Start omp in a terminal.");
				return;
			}
			await vscode.window.showQuickPick(
				sessions.map(session =>
					[
						session.state,
						`pid ${session.endpoint.pid}`,
						`port ${session.endpoint.port}`,
						`terminal "${session.terminalName}"`,
						session.cwd,
						session.sessionId ? `session ${session.sessionId}` : "",
						`${session.edits} edits`,
					]
						.filter(Boolean)
						.join(" · "),
				),
				{ title: "OMP Bridge sessions", placeHolder: "Detected omp endpoints" },
			);
		}),
		vscode.commands.registerCommand("ompBridge.revertEdit", (id?: string) => void revertEdit(id)),
		vscode.commands.registerCommand("ompBridge.sendSelection", () => void sendContext(selectionContext(vscode.window.activeTextEditor))),
		vscode.commands.registerCommand("ompBridge.sendFile", async () =>
			void sendContext(await readForContext(vscode.window.activeTextEditor?.document.uri)),
		),
		vscode.commands.registerCommand("ompBridge.sendProblems", async () => void sendContext(await problemsContext())),
		vscode.commands.registerCommand("ompBridge.sendDiff", async () =>
			void sendContext(
				await diffContext(
					vscode.window.activeTextEditor?.document.uri,
					config().get<DiffScope>("diffScope", "unstaged"),
				),
			),
		),
		vscode.commands.registerCommand("ompBridge.sendSymbol", async () =>
			void sendContext(await symbolContext(vscode.window.activeTextEditor)),
		),
		vscode.commands.registerCommand("ompBridge.sendOpenTabs", () => void sendContext(openTabsContext())),
		vscode.commands.registerCommand("ompBridge.addFiles", async () => void sendContext(await pickFilesContext())),
		vscode.commands.registerCommand("ompBridge.pinSession", async () => {
			const endpoints = readEndpoints();
			if (endpoints.length === 0) {
				await vscode.window.showInformationMessage("OMP Bridge: no live omp process found.");
				return;
			}
			const choice = await vscode.window.showQuickPick(
				endpoints.map(endpoint => ({
					label: `${endpoint.pid}:${endpoint.port}`,
					description: endpoint.cwd,
					picked: state.get<string>(PINNED_KEY) === `${endpoint.pid}:${endpoint.port}`,
				})),
				{ title: "Pin this window to an omp process" },
			);
			if (!choice) return;
			await state.update(PINNED_KEY, choice.label);
			log(`pinned to ${choice.label}`);
		}),
		vscode.commands.registerCommand("ompBridge.unpinSession", async () => {
			await state.update(PINNED_KEY, undefined);
			log("unpinned");
		}),
		vscode.commands.registerCommand("ompBridge.forgetApprovals", async () => {
			await forgetApprovals(state);
			void vscode.window.showInformationMessage("OMP Bridge: cleared saved approvals.");
		}),
		vscode.commands.registerCommand("ompBridge.revealHistory", () => vscode.commands.executeCommand(`${TREE_VIEW_ID}.focus`)),
	);

	log("bridge started");
}

export function deactivate(): void {
	// Disposables registered on the context handle teardown.
}
