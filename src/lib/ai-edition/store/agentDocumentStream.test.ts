// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../schema";
import { AgentDocumentStream } from "./agentDocumentStream";
import { useProjectStore } from "./projectStore";
import { clearHistory, redo, undo } from "./undo";
import { past } from "./undoStack";

const save = vi.hoisted(() => vi.fn());
vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: { save } } }));
const document = (title: string, projectId = "p") => createEmptyDocument({ projectId, title });
beforeEach(() => {
	useProjectStore.getState().clear();
	clearHistory();
	useProjectStore.setState({ projectId: "p", document: document("Before"), revision: 1 });
	save.mockReset().mockImplementation(async (doc) => ({ success: true, document: doc }));
});

describe("completed agent edits", () => {
	it("keeps each applied edit as its existing undo step after stop, without an aggregate resave", async () => {
		const stream = new AgentDocumentStream();
		stream.push(document("First"));
		stream.push(document("Second"));
		await stream.finish();
		stream.push(document("Late"));
		expect(save).toHaveBeenCalledTimes(2);
		expect(past).toHaveLength(2);
		expect(useProjectStore.getState().document?.project.title).toBe("Second");
		expect(undo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("First");
		expect(undo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("Before");
		expect(redo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("First");
	});

	it("drops queued edits after abandonment and never writes into a switched project", async () => {
		const stream = new AgentDocumentStream();
		stream.push(document("Old"));
		stream.close();
		useProjectStore.setState({ projectId: "other", document: document("Other", "other") });
		await stream.finish();
		expect(save).not.toHaveBeenCalled();
		expect(useProjectStore.getState().document?.project.title).toBe("Other");
	});

	it("detects an undo between tool edits instead of overwriting it", async () => {
		const stream = new AgentDocumentStream();
		stream.push(document("First"));
		await vi.waitFor(() => expect(past).toHaveLength(1));
		undo();
		stream.push(document("Second"));
		stream.push(document("Third"));
		await stream.finish();
		expect(stream.failure).toBe("conflict");
		expect(save).toHaveBeenCalledOnce();
		expect(useProjectStore.getState().document?.project.title).toBe("Before");
		// The existing Apply anyway action resumes only the unapplied steps.
		await stream.applyRemaining();
		expect(save).toHaveBeenCalledTimes(3);
		expect(useProjectStore.getState().document?.project.title).toBe("Third");
		expect(undo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("Second");
		expect(undo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("Before");
	});

	it("can start another stream on the stopped turn's applied document", async () => {
		const first = new AgentDocumentStream();
		first.push(document("First"));
		await first.finish();
		const next = new AgentDocumentStream();
		next.push(document("Next"));
		await next.finish();
		expect(next.failure).toBeNull();
		expect(past).toHaveLength(2);
		expect(undo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("First");
	});
});
