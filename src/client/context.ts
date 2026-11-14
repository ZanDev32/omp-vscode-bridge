/**
 * Composes context payloads the editor sends into a running session.
 * Text is plain markdown; the agent sees it as a user message.
 */
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import type { ContextKind } from "../protocol";

const run = promisify(execFile);

const MAX_SNIPPET_BYTES = 200_000;

export interface ContextPayload {
	kind: ContextKind;
	text: string;
}

function languageOf(documentId: vscode.TextDocument): string {
	return documentId.languageId || "text";
}

function fence(language: string, body: string): string {
	return ["```" + language, body, "```"].join("\n");
}

function relative(root: string | undefined, file: string): string {
	return root ? path.relative(root, file).split(path.sep).join("/") : file;
}

export function selectionContext(editor: vscode.TextEditor | undefined): ContextPayload | undefined {
	const document = editor?.document;
	const selection = editor?.selection;
	if (!editor || !document || !selection || selection.isEmpty) return undefined;
	const root = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
	const start = selection.start.line + 1;
	const end = selection.end.line + 1;
	const qualifier = `#L${start}C${selection.start.character + 1}-L${end}C${selection.end.character + 1}`;
	const head = `@${relative(root, document.uri.fsPath)}${qualifier}`;
	return { kind: "selection", text: `${head}\n${fence(languageOf(document), document.getText(selection))}` };
}

export function fileContext(uri: vscode.Uri | undefined): ContextPayload | undefined {
	if (!uri || uri.scheme !== "file") return undefined;
	const root = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
	return {
		kind: "file",
		text: `@${relative(root, uri.fsPath)}`,
	};
}

export async function problemsContext(): Promise<ContextPayload | undefined> {
	const lines: string[] = [];
	for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
		const root = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
		const severity = ["error", "warning", "info", "hint"];
		for (const diagnostic of diagnostics) {
			if (diagnostic.severity > vscode.DiagnosticSeverity.Warning) continue;
			const line = diagnostic.range.start.line + 1;
			lines.push(
				`${relative(root, uri.fsPath)}:${line}:${diagnostic.range.start.character + 1} ${severity[diagnostic.severity] ?? "info"} ${diagnostic.message}`,
			);
		}
	}
	if (lines.length === 0) return undefined;
	const clipped = lines.slice(0, 200);
	const marker = lines.length > clipped.length ? `\n… ${lines.length - clipped.length} more` : "";
	return { kind: "problems", text: `workspace diagnostics:\n${fence("text", clipped.join("\n") + marker)}` };
}

export type DiffScope = "unstaged" | "staged" | "head";

async function git(args: string[], cwd: string): Promise<string | undefined> {
	try {
		const { stdout } = await run("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 });
		return stdout;
	} catch {
		return undefined;
	}
}

/** Diff of one file against the working tree, the index, or HEAD. */
export async function diffContext(uri: vscode.Uri | undefined, scope: DiffScope): Promise<ContextPayload | undefined> {
	if (!uri || uri.scheme !== "file") return undefined;
	const dir = path.dirname(uri.fsPath);
	const root = (await git(["rev-parse", "--show-toplevel"], dir))?.trim();
	if (!root) return undefined;
	const relative = path.relative(root, uri.fsPath).split(path.sep).join("/");
	const args = ["diff", "--no-color"];
	if (scope === "staged") args.push("--cached");
	if (scope === "head") args.push("HEAD");
	args.push("--", relative);
	const diff = (await git(args, root)) ?? "";
	const body = diff.trim() ? diff : `(no ${scope} changes for ${relative})`;
	return { kind: "file", text: `@${relative} ${scope} diff:\n${fence("diff", body)}` };
}

/** Enclosing LSP symbol at the cursor plus its source snippet. */
export async function symbolContext(editor: vscode.TextEditor | undefined): Promise<ContextPayload | undefined> {
	const document = editor?.document;
	const position = editor?.selection.active;
	if (!editor || !document || !position) return undefined;
	const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
		"vscode.executeDocumentSymbolProvider",
		document.uri,
	);
	if (!symbols?.length) return undefined;
	const afterStart = (range: vscode.Range): boolean =>
		position.line > range.start.line || (position.line === range.start.line && position.character >= range.start.character);
	const beforeEnd = (range: vscode.Range): boolean =>
		position.line < range.end.line || (position.line === range.end.line && position.character <= range.end.character);
	const contains = (symbol: vscode.DocumentSymbol): boolean => afterStart(symbol.range) && beforeEnd(symbol.range);
	let innermost: vscode.DocumentSymbol | undefined;
	const visit = (list: vscode.DocumentSymbol[]): void => {
		for (const symbol of list) {
			if (!contains(symbol)) continue;
			innermost = symbol;
			visit(symbol.children);
		}
	};
	visit(symbols);
	if (!innermost) return undefined;
	const root = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
	const range = innermost.range;
	const end = Math.min(range.end.line, range.start.line + 200);
	const snippet = document.getText(new vscode.Range(range.start.line, 0, end, Number.MAX_SAFE_INTEGER));
	return {
		kind: "selection",
		text: `@${relative(root, document.uri.fsPath)}#L${range.start.line + 1}-L${end + 1} symbol ${innermost.name}\n${fence(languageOf(document), snippet)}`,
	};
}

/** References for every open text editor tab. */
export function openTabsContext(): ContextPayload | undefined {
	const refs: string[] = [];
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			const input = tab.input as { uri?: vscode.Uri } | undefined;
			if (!input?.uri || input.uri.scheme !== "file") continue;
			const root = vscode.workspace.getWorkspaceFolder(input.uri)?.uri.fsPath;
			const ref = `@${relative(root, input.uri.fsPath)}`;
			if (!refs.includes(ref)) refs.push(ref);
		}
	}
	if (refs.length === 0) return undefined;
	return { kind: "file", text: `open tabs (${refs.length}):\n${refs.slice(0, 40).join("\n")}` };
}

/** Multi-select of workspace files, returned as references. */
export async function pickFilesContext(): Promise<ContextPayload | undefined> {
	const files = await vscode.workspace.findFiles("**/*", "**/node_modules/**", 2000);
	if (files.length === 0) return undefined;
	const picked = await vscode.window.showQuickPick(
		files.slice(0, 2000).map(uri => ({ label: vscode.workspace.asRelativePath(uri, false), uri })),
		{ canPickMany: true, title: "Add files to the omp prompt", placeHolder: "Select one or more files" },
	);
	if (!picked?.length) return undefined;
	return { kind: "file", text: picked.map(item => `@${item.label}`).join("\n") };
}

/** Compact snapshot the server injects before every turn. */
export function turnSnapshot(shareDiagnostics: boolean): string {
	const editor = vscode.window.activeTextEditor;
	const lines: string[] = [];
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (root) lines.push(`workspace: ${root}`);
	if (editor) {
		const document = editor.document;
		const ref = relative(root, document.uri.fsPath);
		lines.push(`active file: @${ref} (${languageOf(document)})`);
		const selection = editor.selection;
		if (!selection.isEmpty) {
			lines.push(
				`selection: #L${selection.start.line + 1}C${selection.start.character + 1}-L${selection.end.line + 1}C${selection.end.character + 1}`,
				fence(languageOf(document), document.getText(selection).slice(0, 4000)),
			);
		}
	} else {
		lines.push("active file: none");
	}
	if (shareDiagnostics) {
		const problems: string[] = [];
		let errors = 0;
		let warnings = 0;
		for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
			for (const diagnostic of diagnostics) {
				if (diagnostic.severity === vscode.DiagnosticSeverity.Error) errors++;
				else if (diagnostic.severity === vscode.DiagnosticSeverity.Warning) warnings++;
				if (problems.length < 10 && diagnostic.severity <= vscode.DiagnosticSeverity.Warning) {
					problems.push(
						`${relative(root, uri.fsPath)}:${diagnostic.range.start.line + 1} ${diagnostic.message.slice(0, 160)}`,
					);
				}
			}
		}
		lines.push(`diagnostics: ${errors} error(s), ${warnings} warning(s)`);
		if (problems.length) lines.push(...problems);
	}
	return lines.length ? lines.join("\n") : "";
}

/** Reads a file for a full-file payload, refusing anything oversized. */
export async function readForContext(uri: vscode.Uri | undefined): Promise<ContextPayload | undefined> {
	const base = fileContext(uri);
	if (!base || !uri) return undefined;
	try {
		const bytes = await vscode.workspace.fs.readFile(uri);
		if (bytes.byteLength > MAX_SNIPPET_BYTES) return { kind: "file", text: base.text };
		const document = await vscode.workspace.openTextDocument(uri);
		return { kind: "file", text: `${base.text}\n${fence(languageOf(document), document.getText())}` };
	} catch {
		return base;
	}
}
