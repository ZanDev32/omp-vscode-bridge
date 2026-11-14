/**
 * Opening edits without stealing focus: a diff against git HEAD when the file
 * is tracked, otherwise a plain silent open.
 */
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";

const run = promisify(execFile);

export const SCHEME = "omp-bridge-head";
export const PROPOSED_SCHEME = "omp-bridge-proposed";

const proposals = new Map<string, string>();

/** Content provider for `approval_request` previews; keyed by request id. */
export const proposedProvider: vscode.TextDocumentContentProvider = {
	provideTextDocumentContent(uri: vscode.Uri): string {
		return proposals.get(new URLSearchParams(uri.query).get("id") ?? "") ?? "";
	},
};

/**
 * Shows the pending write before it happens: proposed content on the left,
 * the file on disk on the right (or the proposal alone for a new file).
 */
export async function showProposal(requestId: string, file: string, content: string, exists: boolean): Promise<void> {
	proposals.set(requestId, content);
	const left = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: `/${path.basename(file)}`, query: `id=${encodeURIComponent(requestId)}` });
	if (!exists) {
		await vscode.window.showTextDocument(left, { preview: true, preserveFocus: true });
		return;
	}
	await vscode.commands.executeCommand("vscode.diff", left, vscode.Uri.file(file), `OMP Bridge: Proposed ${path.basename(file)}`, {
		preview: true,
		preserveFocus: true,
	});
}

export function clearProposal(requestId: string): void {
	proposals.delete(requestId);
}

const repoRoots = new Map<string, string | undefined>();

async function git(args: string[], cwd: string): Promise<string | undefined> {
	try {
		const { stdout } = await run("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
		return stdout;
	} catch {
		return undefined;
	}
}

async function repoRoot(dir: string): Promise<string | undefined> {
	if (repoRoots.has(dir)) return repoRoots.get(dir);
	const top = (await git(["rev-parse", "--show-toplevel"], dir))?.trim();
	repoRoots.set(dir, top);
	return top;
}

interface HeadTarget {
	root: string;
	relative: string;
}

/** Explicit URI encoding keeps remotes, spaces, and unicode in paths intact. */
function headUri(target: HeadTarget): vscode.Uri {
	return vscode.Uri.from({ scheme: SCHEME, path: `/${target.relative}`, query: `root=${encodeURIComponent(target.root)}` });
}

class HeadContentProvider implements vscode.TextDocumentContentProvider {
	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const root = decodeURIComponent(new URLSearchParams(uri.query).get("root") ?? "");
		const relative = uri.path.replace(/^\//, "");
		const content = await git(["show", `HEAD:${relative}`], root || path.dirname(uri.fsPath));
		if (content === undefined) throw new Error(`No HEAD version for ${relative}`);
		return content;
	}
}

export const headProvider = new HeadContentProvider();

async function trackedInHead(file: string): Promise<HeadTarget | undefined> {
	const dir = path.dirname(file);
	const root = await repoRoot(dir);
	if (!root) return undefined;
	const relative = path.relative(root, file).split(path.sep).join("/");
	if (!relative || relative.startsWith("..")) return undefined;
	const exists = (await git(["cat-file", "-e", `HEAD:${relative}`], root)) !== undefined;
	return exists ? { root, relative } : undefined;
}

async function openSilently(uri: vscode.Uri): Promise<void> {
	await vscode.workspace.openTextDocument(uri);
	await vscode.window.showTextDocument(uri, { preview: false, preserveFocus: true });
}

/** Returns what it did: "diff", "open", or "skip" when the file is unreadable. */
export async function surfaceEdit(file: string): Promise<"diff" | "open" | "skip"> {
	const target = path.resolve(file);
	const uri = vscode.Uri.file(target);
	const head = await trackedInHead(target);
	if (head) {
		await vscode.commands.executeCommand(
			"vscode.diff",
			headUri(head),
			uri,
			`OMP Bridge: Diff ${path.basename(target)}`,
			{ preview: false, preserveFocus: true },
		);
		return "diff";
	}
	try {
		await openSilently(uri);
		return "open";
	} catch {
		return "skip";
	}
}
