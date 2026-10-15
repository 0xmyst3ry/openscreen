import { describe, expect, it, vi } from "vitest";
import {
	DIAGNOSTIC_PROJECT_STATE_TIMEOUT_MS,
	resolveDiagnosticProjectState,
} from "./project-state";

const editorWith = (snapshot: { document: unknown; revision: number } | null) => ({
	snapshot: vi.fn(async (_timeoutMs?: number) => snapshot),
});

describe("resolveDiagnosticProjectState", () => {
	it("writes the editor's document, not the snapshot wrapping it", async () => {
		const document = { project: { id: "p1" }, timeline: [] };
		const host = editorWith({ document, revision: 7 });
		await expect(resolveDiagnosticProjectState(null, host)).resolves.toBe(document);
		expect(host.snapshot).toHaveBeenCalledWith(DIAGNOSTIC_PROJECT_STATE_TIMEOUT_MS);
	});

	it("keeps a state the caller passed, without asking the editor", async () => {
		const supplied = { project: { id: "from-renderer" } };
		const host = editorWith({ document: { project: { id: "p1" } }, revision: 1 });
		await expect(resolveDiagnosticProjectState(supplied, host)).resolves.toBe(supplied);
		expect(host.snapshot).not.toHaveBeenCalled();
	});

	it("is null when no editor holds a document, or there is no host", async () => {
		await expect(resolveDiagnosticProjectState(null, editorWith(null))).resolves.toBeNull();
		await expect(resolveDiagnosticProjectState(undefined, null)).resolves.toBeNull();
	});
});
