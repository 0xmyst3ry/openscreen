import { describe, expect, it } from "vitest";
import { ChatRuns } from "./chatRuns";

describe("chat turn ownership", () => {
	it("matches owner, project, session and turn, and accepts repeat stops idempotently", () => {
		const runs = new ChatRuns<object>();
		const owner = {};
		const turn = runs.start(owner, "p", "s", "r")!;
		expect(runs.start({}, "p", "s2", "r2")).toBeNull();
		expect(runs.cancel({}, "p", "s", "r")).toBe(false);
		expect(runs.cancel(owner, "other", "s", "r")).toBe(false);
		expect(runs.cancel(owner, "p", "other", "r")).toBe(false);
		expect(runs.cancel(owner, "p", "s", "old")).toBe(false);
		expect(turn.signal.aborted).toBe(false);
		expect(runs.cancel(owner, "p", "s", "r")).toBe(true);
		expect(runs.cancel(owner, "p", "s", "r")).toBe(true);
		expect(turn.signal.aborted).toBe(true);
	});

	it("isolates projects and keeps stale cancellation/cleanup out of the next turn", () => {
		const runs = new ChatRuns<object>();
		const owner = {};
		const old = runs.start(owner, "p", "s", "old")!;
		const other = runs.start(owner, "other", "s", "other")!;
		runs.cancel(owner, "p", "s", "old");
		old.finish();
		const next = runs.start(owner, "p", "s", "new")!;
		old.finish();
		expect(runs.cancel(owner, "p", "s", "old")).toBe(false);
		expect(runs.start(owner, "p", "s", "another")).toBeNull();
		expect(next.signal.aborted).toBe(false);
		expect(other.signal.aborted).toBe(false);
		next.finish();
		expect(runs.cancel(owner, "p", "s", "new")).toBe(false);
	});
});
