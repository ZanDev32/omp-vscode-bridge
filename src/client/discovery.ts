/**
 * Endpoint discovery: read the server records omp publishes and match them to
 * terminals owned by this window.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { type EndpointRecord, isPathInside, parseEndpointRecord } from "../protocol";

export const ENDPOINT_DIR = path.join(os.homedir(), ".omp-vscode", "servers");

export interface EndpointMatch {
	endpoint: EndpointRecord;
	terminal: vscode.Terminal;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Parsed endpoint records whose owning process is still running. */
export function readEndpoints(): EndpointRecord[] {
	let names: string[];
	try {
		names = fs.readdirSync(ENDPOINT_DIR).filter(name => name.endsWith(".json"));
	} catch {
		return [];
	}
	const endpoints: EndpointRecord[] = [];
	for (const name of names) {
		try {
			const endpoint = parseEndpointRecord(JSON.parse(fs.readFileSync(path.join(ENDPOINT_DIR, name), "utf8")));
			if (endpoint && isAlive(endpoint.pid)) endpoints.push(endpoint);
		} catch {
			// Unreadable or half-written record: ignore until the next scan.
		}
	}
	return endpoints;
}

/**
 * Match endpoints to terminals: exact terminal-pid ancestry first, then the
 * single-terminal window whose workspace contains the process cwd.
 */
export async function discoverMatches(workspaceRoots: string[]): Promise<EndpointMatch[]> {
	const terminals = await Promise.all(
		vscode.window.terminals.map(async terminal => ({
			terminal,
			pid: await Promise.resolve(terminal.processId).catch(() => undefined),
		})),
	);
	const matches: EndpointMatch[] = [];
	for (const endpoint of readEndpoints()) {
		const byPid = terminals.find(candidate => candidate.pid !== undefined && endpoint.ancestorPids.includes(candidate.pid));
		if (byPid) {
			matches.push({ endpoint, terminal: byPid.terminal });
			continue;
		}
		const only = terminals[0];
		if (terminals.length === 1 && only && workspaceRoots.some(root => isPathInside(root, endpoint.cwd))) {
			matches.push({ endpoint, terminal: only.terminal });
		}
	}
	return matches;
}
