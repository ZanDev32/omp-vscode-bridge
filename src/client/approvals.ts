/**
 * "Always Allow" cache for the approval gate, scoped to the workspace.
 * Keys are tool + absolute path so granting one file never widens another.
 */
import * as vscode from "vscode";

const KEY = "ompBridge.autoApproved";
const LIMIT = 200;

const key = (tool: string, file: string): string => `${tool}:${file}`;

export function isAutoApproved(state: vscode.Memento, tool: string, file: string): boolean {
	return (state.get<string[]>(KEY, []) ?? []).includes(key(tool, file));
}

export async function rememberApproval(state: vscode.Memento, tool: string, file: string): Promise<void> {
	const existing = state.get<string[]>(KEY, []) ?? [];
	const entry = key(tool, file);
	await state.update(KEY, [entry, ...existing.filter(item => item !== entry)].slice(0, LIMIT));
}

export async function forgetApprovals(state: vscode.Memento): Promise<void> {
	await state.update(KEY, []);
}
