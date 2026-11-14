/**
 * Session-local record of agent edits, enough to review and revert the last one.
 * Nothing is persisted: reverting is only offered for edits this window saw.
 */
import * as path from "node:path";
import * as vscode from "vscode";

export interface EditRecord {
	id: string;
	sessionId: string;
	path: string;
	tool: string;
	at: string;
	previous?: string;
	created?: boolean;
	surfaced: string;
}

const LIMIT = 50;

export class EditHistory implements vscode.TreeDataProvider<EditRecord> {
	private records: EditRecord[] = [];
	private readonly changed = new vscode.EventEmitter<EditRecord | undefined>();
	readonly onDidChangeTreeData = this.changed.event;

	add(record: Omit<EditRecord, "id">): EditRecord {
		const entry: EditRecord = { ...record, id: `${record.at}:${record.path}:${Math.random().toString(36).slice(2, 8)}` };
		this.records.unshift(entry);
		this.records = this.records.slice(0, LIMIT);
		this.changed.fire(undefined);
		return entry;
	}

	get(id: string): EditRecord | undefined {
		return this.records.find(record => record.id === id);
	}

	list(): EditRecord[] {
		return [...this.records];
	}

	getTreeItem(record: EditRecord): vscode.TreeItem {
		const relative = vscode.workspace.asRelativePath(record.path, false);
		const item = new vscode.TreeItem(`${path.basename(record.path)}`, vscode.TreeItemCollapsibleState.None);
		item.description = `${record.tool} · ${record.surfaced} · ${new Date(record.at).toLocaleTimeString()} · ${relative}`;
		item.tooltip = `${record.path}\n${record.created ? "created by the agent" : "had prior content"}`;
		item.contextValue = "ompBridgeEdit";
		item.command = { command: "ompBridge.revertEdit", title: "Revert", arguments: [record.id] };
		item.resourceUri = vscode.Uri.file(record.path);
		return item;
	}

	getChildren(): EditRecord[] {
		return this.list();
	}

	fire(): void {
		this.changed.fire(undefined);
	}
}

/** Restores the pre-edit state: rewrite prior text, or delete a file the agent created. */
export async function revert(record: EditRecord): Promise<void> {
	const uri = vscode.Uri.file(record.path);
	if (record.created) {
		await vscode.workspace.fs.delete(uri, { useTrash: true });
		return;
	}
	if (record.previous === undefined) throw new Error("no snapshot for this edit");
	await vscode.workspace.fs.writeFile(uri, Buffer.from(record.previous, "utf8"));
	await vscode.window.showTextDocument(uri, { preview: false, preserveFocus: true });
}
