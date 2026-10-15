import type { EditorDocumentHost } from "../mcp/editor-document-host";

/**
 * How long Save Diagnostics waits for the editor's document. A hung editor is exactly
 * when a bundle is wanted, so it must not hold the save for an MCP call's 30 s.
 */
export const DIAGNOSTIC_PROJECT_STATE_TIMEOUT_MS = 5_000;

/**
 * The `projectState` a diagnostic bundle carries: what the caller passed, else the open
 * editor's live document — the document itself, not the `{ document, revision }`
 * snapshot it arrives in — else `null`. The tray and the menus pass nothing, having no
 * renderer to ask; `host` is the one the MCP server reads the editor through.
 */
export async function resolveDiagnosticProjectState(
	supplied: unknown,
	host: Pick<EditorDocumentHost, "snapshot"> | null,
): Promise<unknown> {
	if (supplied !== null && supplied !== undefined) return supplied;
	const snapshot = await host?.snapshot(DIAGNOSTIC_PROJECT_STATE_TIMEOUT_MS);
	return snapshot?.document ?? null;
}
