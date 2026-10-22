import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiEditionChatResult, NativeBridgeResponse } from "../../src/native/contracts";
import type { ChatEventSink } from "../ai-edition/chat-service";
import { type NativeBridgeContext, registerNativeBridgeHandlers } from "./nativeBridge";

const electron = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock("electron", () => ({
	app: { getAppPath: () => "", isPackaged: false },
	ipcMain: { handle: electron.handle, removeHandler: vi.fn() },
	shell: {},
}));
vi.mock("../native-bridge/services/compositorViewService", () => ({
	CompositorViewService: class {},
}));
class Sender extends EventEmitter {
	send = vi.fn();
}
let handler: (event: { sender: Sender }, request: unknown) => Promise<NativeBridgeResponse>;
const runChat = vi.fn<NativeBridgeContext["runAiEditionChat"]>();
beforeEach(() => {
	electron.handle.mockClear();
	runChat.mockReset();
	registerNativeBridgeHandlers({
		getPlatform: () => "linux",
		getAiEditionDocuments: () => ({}),
		runAiEditionChat: runChat,
	} as unknown as NativeBridgeContext);
	handler = electron.handle.mock.calls[0][1];
});
const payload = { projectId: "p", sessionId: "s", runId: "r", message: "hello" };
function invoke(sender: Sender, action: string, data: unknown = payload) {
	return handler({ sender }, { domain: "aiEdition", action, payload: data });
}
function pendingTurn() {
	let finish!: (result: AiEditionChatResult) => void;
	let signal: AbortSignal | undefined;
	let sink: ChatEventSink | undefined;
	runChat.mockImplementation((_p, _s, _m, _d, events, abort) => {
		signal = abort;
		sink = events;
		return new Promise((resolve) => {
			finish = resolve;
		});
	});
	return { finish: () => finish({ success: true }), signal: () => signal!, sink: () => sink! };
}

describe("chat IPC", () => {
	it.each([
		null,
		{},
		{ ...payload, runId: "" },
		{ ...payload, projectId: 1 },
		{ ...payload, sessionId: "../s" },
	])("validates cancel identities before dispatch: %s", async (data) => {
		const response = await invoke(new Sender(), "chat.cancel", data);
		expect(response.ok ? null : response.error.code).toBe("INVALID_REQUEST");
	});

	it("rejects empty messages and documents belonging to another project", async () => {
		for (const data of [
			{ ...payload, message: " " },
			{ ...payload, document: { project: { id: "other" } } },
		]) {
			const response = await invoke(new Sender(), "chat.run", data);
			expect(response.ok ? null : response.error.code).toBe("INVALID_REQUEST");
		}
		expect(runChat).not.toHaveBeenCalled();
	});

	it("owns the AbortController, sends turn-scoped events, and silences late events", async () => {
		const pending = pendingTurn();
		const owner = new Sender();
		const stranger = new Sender();
		const running = invoke(owner, "chat.run");
		pending.sink().text?.("before");
		expect(owner.send).toHaveBeenCalledWith("ai-edition.chat-event", {
			projectId: "p",
			sessionId: "s",
			runId: "r",
			kind: "text",
			delta: "before",
		});
		for (const [sender, data] of [
			[stranger, payload],
			[owner, { ...payload, projectId: "other" }],
			[owner, { ...payload, runId: "old" }],
		] as const) {
			const response = await invoke(sender, "chat.cancel", data);
			expect(response.ok && response.data).toEqual({ accepted: false });
		}
		expect(pending.signal().aborted).toBe(false);
		for (let i = 0; i < 2; i++) {
			const response = await invoke(owner, "chat.cancel");
			expect(response.ok && response.data).toEqual({ accepted: true });
		}
		expect(pending.signal().aborted).toBe(true);
		pending.sink().text?.("late");
		pending.sink().document?.({} as never);
		expect(owner.send).toHaveBeenCalledOnce();
		pending.finish();
		await running;
		expect(owner.listenerCount("destroyed")).toBe(0);
		const response = await invoke(owner, "chat.cancel");
		expect(response.ok && response.data).toEqual({ accepted: false });
	});

	it("aborts on window destruction and releases the project after a failed run", async () => {
		const pending = pendingTurn();
		const owner = new Sender();
		const running = invoke(owner, "chat.run");
		owner.emit("destroyed");
		expect(pending.signal().aborted).toBe(true);
		pending.finish();
		await running;
		runChat.mockRejectedValueOnce(new Error("failed"));
		await invoke(owner, "chat.run", { ...payload, runId: "fail" });
		expect(owner.listenerCount("destroyed")).toBe(0);
		runChat.mockResolvedValueOnce({ success: true });
		expect((await invoke(owner, "chat.run", { ...payload, runId: "next" })).ok).toBe(true);
	});
});
