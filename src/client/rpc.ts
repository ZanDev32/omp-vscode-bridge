/**
 * Requests the omp side can make of this window: its language-model tools
 * (including MCP servers VS Code manages), diagnostics, commands, debug
 * sessions, and tasks. Every handler throws on failure; the caller serializes
 * the error back to the model.
 */
import * as vscode from "vscode";
import { turnSnapshot } from "./context";

const MAX_RESULT_CHARS = 100_000;

function stringify(value: unknown): string {
	let text: string;
	try {
		text = typeof value === "string" ? value : JSON.stringify(value, undefined, 2);
	} catch {
		text = String(value);
	}
	if (text === undefined) return "null";
	return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n… truncated` : text;
}

function toolResultText(result: vscode.LanguageModelToolResult): string {
	const parts: string[] = [];
	for (const part of result.content ?? []) {
		if (part instanceof vscode.LanguageModelTextPart) parts.push(part.value);
		else if (part instanceof vscode.LanguageModelDataPart) parts.push(`[data ${part.mimeType}, ${part.data.byteLength} bytes]`);
		else parts.push(stringify(part));
	}
	return parts.length ? parts.join("\n") : "(no content)";
}

function diagnosticsText(params: Record<string, unknown>): string {
	const wanted = typeof params.path === "string" ? vscode.Uri.file(params.path) : undefined;
	const onlyErrors = params.severity === "errors";
	const severityName = ["error", "warning", "info", "hint"];
	const lines: string[] = [];
	for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
		if (wanted && uri.fsPath !== wanted.fsPath) continue;
		for (const diagnostic of diagnostics) {
			if (onlyErrors && diagnostic.severity !== vscode.DiagnosticSeverity.Error) continue;
			lines.push(
				`${vscode.workspace.asRelativePath(uri, false)}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} ${severityName[diagnostic.severity] ?? "info"} ${diagnostic.message}`,
			);
		}
	}
	return lines.length ? lines.slice(0, 500).join("\n") : "no diagnostics";
}

function allowedCommands(): string[] {
	return vscode.workspace.getConfiguration("ompBridge").get<string[]>("allowedCommands", []);
}

async function runCommand(params: Record<string, unknown>): Promise<string> {
	const command = typeof params.command === "string" ? params.command : "";
	if (!command) throw new Error("command is required");
	const allowed = allowedCommands();
	if (!allowed.includes(command)) {
		throw new Error(`command "${command}" is not in ompBridge.allowedCommands (allowed: ${allowed.join(", ") || "none"})`);
	}
	const args = Array.isArray(params.args) ? params.args : [];
	const confirm = vscode.workspace.getConfiguration("ompBridge").get<boolean>("confirmCommands", true);
	if (confirm) {
		const choice = await vscode.window.showWarningMessage(
			`OMP wants to run VS Code command: ${command}`,
			{ modal: true, detail: args.length ? `Arguments: ${stringify(args)}` : undefined },
			"Run",
		);
		if (choice !== "Run") return "denied by the user";
	}
	const result = await vscode.commands.executeCommand(command, ...args);
	return stringify(result === undefined ? `ran ${command}` : result);
}

async function debugAction(params: Record<string, unknown>): Promise<string> {
	const action = params.action === "stop" ? "stop" : "start";
	if (action === "stop") {
		const stopped: string[] = [];
		for (const session of vscode.debug.activeDebugSession ? [vscode.debug.activeDebugSession] : []) {
			stopped.push(session.name);
			await vscode.debug.stopDebugging(session);
		}
		return stopped.length ? `stopped ${stopped.join(", ")}` : "no active debug session";
	}
	const name = typeof params.name === "string" ? params.name : "";
	if (!name) throw new Error("name is required (a launch.json configuration name)");
	const folder = vscode.workspace.workspaceFolders?.[0];
	const started = await vscode.debug.startDebugging(folder, name);
	if (!started) throw new Error(`VS Code refused to start "${name}"`);
	return `started ${name}`;
}

async function taskAction(params: Record<string, unknown>): Promise<string> {
	if (params.action !== "run") {
		const tasks = await vscode.tasks.fetchTasks();
		return tasks.length ? tasks.map(task => `${task.source}: ${task.name}`).join("\n") : "no tasks";
	}
	const name = typeof params.name === "string" ? params.name : "";
	const tasks = await vscode.tasks.fetchTasks();
	const task = tasks.find(candidate => candidate.name === name);
	if (!task) throw new Error(`unknown task "${name}" (available: ${tasks.map(t => t.name).join(", ") || "none"})`);
	const execution = await vscode.tasks.executeTask(task);
	return `started task ${task.name} (${execution.task.name})`;
}

export async function handleRpc(method: string, params: Record<string, unknown>): Promise<string> {
	switch (method) {
		case "lm.list": {
			const tools = vscode.lm.tools.map(tool => ({
				name: tool.name,
				description: tool.description,
				tags: tool.tags ?? [],
			}));
			return tools.length ? stringify(tools) : "no VS Code language-model tools are registered in this window";
		}
		case "lm.invoke": {
			const name = typeof params.name === "string" ? params.name : "";
			if (!name) throw new Error("name is required");
			const input = typeof params.input === "string" ? JSON.parse(params.input) : (params.input ?? {});
			const result = await vscode.lm.invokeTool(name, { input: input as object, toolInvocationToken: undefined });
			return toolResultText(result);
		}
		case "diagnostics":
			return diagnosticsText(params);
		case "context.snapshot": {
			const config = vscode.workspace.getConfiguration("ompBridge");
			if (!config.get<boolean>("shareContext", true)) return "";
			return turnSnapshot(config.get<boolean>("includeDiagnostics", true));
		}
		case "command":
			return runCommand(params);
		case "debug":
			return debugAction(params);
		case "task":
			return taskAction(params);
		default:
			throw new Error(`unknown method ${method}`);
	}
}
