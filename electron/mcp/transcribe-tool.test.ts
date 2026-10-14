// The transcribe tool through the runner both servers share: a project on file is
// transcribed by the injected Whisper and lands like an edit; the project open in the
// editor is handed to the editor's own job instead.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AxcutDocument,
	createEmptyDocument,
	documentSchema,
} from "../../src/lib/ai-edition/schema";
import { DocumentService } from "../ai-edition/document-service";
import type { SttTranscribeRequest, SttTranscribeResponse } from "../stt/transcriptionContract";
import {
	createToolRunner,
	type McpApplyResult,
	type McpDocumentHost,
	mcpInstructions,
	TRANSCRIBE_TOOL,
} from "./openscreen-mcp-server";

function fixtureDocument(projectId: string): AxcutDocument {
	const base = createEmptyDocument({
		title: projectId,
		projectId,
		createdAt: "2026-01-01T00:00:00.000Z",
	});
	return documentSchema.parse({
		...base,
		project: { ...base.project, primaryAssetId: "asset_1", vocabulary: "OpenScreen" },
		assets: [
			{ id: "asset_1", kind: "video", label: "Rec", originalPath: "/tmp/rec.mp4", durationSec: 30 },
		],
	});
}

const SPEECH: SttTranscribeResponse = {
	segments: [{ text: "Hello world", startSec: 0, endSec: 1 }],
	wordSegments: [
		{ word: "Hello", startSec: 0, endSec: 0.5 },
		{ word: "world", startSec: 0.5, endSec: 1 },
	],
	detectedLanguage: "en",
	backend: "whispercpp-cpu",
};

/** No editor holds a project unless a test opens one. */
class Host implements McpDocumentHost {
	document: AxcutDocument | null = null;
	transcribe = vi.fn(async () => ({ status: "transcribed" as const, language: "fr", words: 3 }));
	async snapshot() {
		return this.document ? { document: structuredClone(this.document), revision: 1 } : null;
	}
	async apply(document: AxcutDocument): Promise<McpApplyResult> {
		this.document = document;
		return "applied";
	}
}

let dir: string;
let projects: DocumentService;

beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "openscreen-mcp-transcribe-"));
	projects = new DocumentService(path.join(dir, "projects"), dir);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function runnerWith(whisper: (request: SttTranscribeRequest) => Promise<SttTranscribeResponse>) {
	const host = new Host();
	const transcribe = vi.fn(whisper);
	const run = createToolRunner({
		transport: "stdio",
		host,
		projects,
		editsAllowed: () => true,
		transcribe,
		version: "0.0.0",
	});
	return { run, host, transcribe };
}

function payload(result: CallToolResult): Record<string, unknown> {
	const part = result.content[0];
	return JSON.parse(part?.type === "text" ? part.text : "{}");
}

describe("transcribe, on a project's file", () => {
	it("transcribes with the project's vocabulary and lands the words, with no checkpoint", async () => {
		await projects.saveProject(fixtureDocument("proj_1"));
		const { run, transcribe } = runnerWith(async () => SPEECH);

		const result = await run(TRANSCRIBE_TOOL, { projectId: "proj_1" });

		expect(result.isError).toBeUndefined();
		expect(payload(result)).toMatchObject({ assetId: "asset_1", language: "en", words: 2 });
		expect(transcribe).toHaveBeenCalledWith({
			sourcePath: "/tmp/rec.mp4",
			language: undefined,
			prompt: "OpenScreen",
		});
		const saved = await projects.getProject("proj_1");
		expect(saved.transcripts[0]?.words.map((w) => w.text)).toEqual(["Hello", "world"]);
	});

	it("keeps a transcript without a language, and redoes it with one", async () => {
		await projects.saveProject(fixtureDocument("proj_1"));
		const { run, transcribe } = runnerWith(async () => SPEECH);
		await run(TRANSCRIBE_TOOL, { projectId: "proj_1" });

		const kept = await run(TRANSCRIBE_TOOL, { projectId: "proj_1" });
		expect(payload(kept)).toMatchObject({ unchanged: true, words: 2 });
		expect(transcribe).toHaveBeenCalledTimes(1);

		await run(TRANSCRIBE_TOOL, { projectId: "proj_1", language: "fr" });
		expect(transcribe).toHaveBeenLastCalledWith(expect.objectContaining({ language: "fr" }));
		await run(TRANSCRIBE_TOOL, { projectId: "proj_1", language: "auto" });
		expect(transcribe).toHaveBeenLastCalledWith(expect.objectContaining({ language: undefined }));
	});

	it("reports a silent recording as the editor does, and remembers it on the asset", async () => {
		await projects.saveProject(fixtureDocument("proj_1"));
		const { run } = runnerWith(async () => {
			throw new Error("No decodable audio in /tmp/rec.mp4");
		});

		const result = await run(TRANSCRIBE_TOOL, { projectId: "proj_1" });

		expect(result.isError).toBe(true);
		expect(payload(result).failure).toMatchObject({ kind: "no-audio" });
		const saved = await projects.getProject("proj_1");
		expect(saved.assets[0]?.transcriptionFailure?.kind).toBe("no-audio");
	});

	it("refuses an unknown asset, and while MCP edits are off", async () => {
		await projects.saveProject(fixtureDocument("proj_1"));
		const { run, transcribe } = runnerWith(async () => SPEECH);
		const unknown = await run(TRANSCRIBE_TOOL, { projectId: "proj_1", assetId: "nope" });
		expect(String(payload(unknown).error)).toContain("asset_1");

		const off = await run(TRANSCRIBE_TOOL, { projectId: "proj_1" }, { editsAllowed: false });
		expect(payload(off).code).toBe("consent_required");
		expect(transcribe).not.toHaveBeenCalled();
	});

	it("lets other calls run while Whisper works", async () => {
		await projects.saveProject(fixtureDocument("proj_1"));
		const whisper: { finish: ((response: SttTranscribeResponse) => void) | null } = {
			finish: null,
		};
		const { run } = runnerWith(
			() =>
				new Promise((resolve) => {
					whisper.finish = resolve;
				}),
		);
		const pending = run(TRANSCRIBE_TOOL, { projectId: "proj_1" });
		await vi.waitFor(() => expect(whisper.finish).not.toBeNull());
		// Whisper is still working, and a read goes through all the same.
		const read = await run("getCurrentDocument", { projectId: "proj_1" });
		expect(read.isError).toBeUndefined();
		whisper.finish?.(SPEECH);
		expect((await pending).isError).toBeUndefined();
	});

	it("primes a waiting transcription with the vocabulary set while it waited", async () => {
		await projects.saveProject(fixtureDocument("proj_1"));
		const running: Array<(response: SttTranscribeResponse) => void> = [];
		const { run, transcribe } = runnerWith(
			() =>
				new Promise((resolve) => {
					running.push(resolve);
				}),
		);
		const first = run(TRANSCRIBE_TOOL, { projectId: "proj_1" });
		await vi.waitFor(() => expect(running).toHaveLength(1));
		const second = run(TRANSCRIBE_TOOL, { projectId: "proj_1", language: "fr" });
		await run("createCheckpoint", { projectId: "proj_1" });
		await run("setVocabulary", { projectId: "proj_1", vocabulary: "Vulkan" });
		running.shift()?.(SPEECH);
		await first;
		await vi.waitFor(() => expect(running).toHaveLength(1));
		expect(transcribe).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: "Vulkan" }));
		running.shift()?.(SPEECH);
		await second;
	});

	it("runs no Whisper for a project deleted while it waited", async () => {
		await projects.saveProject(fixtureDocument("proj_1"));
		await projects.saveProject(fixtureDocument("proj_2"));
		const running: Array<(response: SttTranscribeResponse) => void> = [];
		const { run, transcribe } = runnerWith(
			() =>
				new Promise((resolve) => {
					running.push(resolve);
				}),
		);
		const first = run(TRANSCRIBE_TOOL, { projectId: "proj_1" });
		await vi.waitFor(() => expect(running).toHaveLength(1));
		const reads = vi.spyOn(projects, "getProjectForUpdate");
		const second = run(TRANSCRIBE_TOOL, { projectId: "proj_2" });
		// Deleted once the call has found the project, while it waits for Whisper.
		await vi.waitFor(() => expect(reads).toHaveBeenCalledWith("proj_2"));
		await reads.mock.results.at(-1)?.value;
		await projects.deleteProject("proj_2");
		running.shift()?.(SPEECH);
		await first;

		const result = await second;
		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("deleted") });
		expect(transcribe).toHaveBeenCalledTimes(1);
	});

	it("survives a restore to a checkpoint made before it", async () => {
		await projects.saveProject(fixtureDocument("proj_1"));
		const { run } = runnerWith(async () => SPEECH);
		const checkpoint = payload(await run("createCheckpoint", { projectId: "proj_1" }));
		await run(TRANSCRIBE_TOOL, { projectId: "proj_1" });

		await run("restoreCheckpoint", { projectId: "proj_1", checkpointId: checkpoint.checkpointId });

		expect((await projects.getProject("proj_1")).transcripts).toHaveLength(1);
	});
});

describe("the instructions", () => {
	it("name the transcribe tool only where it is served", () => {
		expect(mcpInstructions({ transport: "stdio", editsAllowed: true, transcribe: true })).toContain(
			"transcribe makes an asset's transcript",
		);
		expect(mcpInstructions({ transport: "stdio", editsAllowed: true })).not.toContain(
			"transcribe makes",
		);
	});
});

describe("transcribe, on the project open in the editor", () => {
	it("hands it to the editor's own job rather than running Whisper beside it", async () => {
		const { run, host, transcribe } = runnerWith(async () => SPEECH);
		host.document = fixtureDocument("proj_1");

		const result = await run(TRANSCRIBE_TOOL, { language: "fr" });

		expect(host.transcribe).toHaveBeenCalledWith("proj_1", "asset_1", "fr");
		expect(transcribe).not.toHaveBeenCalled();
		expect(payload(result)).toMatchObject({ assetId: "asset_1", language: "fr", words: 3 });
	});

	it("says so when the editor closes the project mid-run", async () => {
		const { run, host } = runnerWith(async () => SPEECH);
		host.document = fixtureDocument("proj_1");
		host.transcribe.mockResolvedValueOnce("no-editor" as never);

		const result = await run(TRANSCRIBE_TOOL, {});

		expect(result.isError).toBe(true);
	});
});
