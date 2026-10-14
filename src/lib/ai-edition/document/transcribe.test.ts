import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AxcutDocument, axcutSchemaVersion, transcriptSchema } from "../schema";
import { classifyTranscriptionError } from "../transcription/status";
import { transcribeAsset } from "./transcribe";

vi.mock("@/lib/captioning", () => ({
	transcribeSourceFileToSegments: vi.fn(),
}));

const { transcribeSourceFileToSegments } = await import("@/lib/captioning");
// `transcribeAsset` sends the PATH and lets the main process decode.
const transcribeMock = vi.mocked(transcribeSourceFileToSegments);

function makeDoc(): AxcutDocument {
	return {
		schemaVersion: axcutSchemaVersion,
		project: {
			id: "proj_1",
			title: "Test",
			createdAt: "2026-07-03T00:00:00Z",
			updatedAt: "2026-07-03T00:00:00Z",
			primaryAssetId: "asset_1",
		},
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "demo.mp4",
				originalPath: "/tmp/demo.mp4",
				durationSec: 60,
				cameraTrack: null,
			},
		],
		transcript: null,
		transcripts: [],
		timeline: {
			clips: [],
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		audioTracks: [],
		legacyEditor: null,
	};
}

describe("transcribeAsset status sequence", () => {
	it("does not emit transcribing between extract and the worker", async () => {
		const phases: string[] = [];
		transcribeMock.mockImplementationOnce(async (_samples, options) => {
			options?.onStatus?.({ phase: "model" });
			options?.onStatus?.({
				phase: "transcribe",
				completedSec: 1,
				totalSec: 10,
			});
			return { segments: [], granularity: "phrase" as const, detectedLanguage: "en" };
		});

		await transcribeAsset(makeDoc(), "asset_1", {
			onStatus: (status) => phases.push(status.phase),
		});

		expect(phases[0]).toBe("extracting-audio");
		expect(phases[1]).toBe("loading-model");
		expect(phases.indexOf("transcribing")).toBeGreaterThan(1);
		expect(phases.slice(0, phases.indexOf("transcribing"))).not.toContain("transcribing");
	});

	it("forwards model download bytes onto loading-model status", async () => {
		const events: Array<{ phase: string; downloadedBytes?: number; totalBytes?: number }> = [];
		transcribeMock.mockImplementationOnce(async (_samples, options) => {
			options?.onStatus?.({
				phase: "model",
				downloadedBytes: 10,
				totalBytes: 100,
			});
			return { segments: [], granularity: "phrase" as const, detectedLanguage: "en" };
		});

		await transcribeAsset(makeDoc(), "asset_1", {
			onStatus: (status) => events.push(status),
		});

		expect(events).toContainEqual({
			phase: "loading-model",
			downloadedBytes: 10,
			totalBytes: 100,
		});
	});
});

describe("transcribeAsset language handling", () => {
	it("forwards a forced language to the worker and stores it on the transcript", async () => {
		transcribeMock.mockResolvedValueOnce({
			segments: [{ startSec: 0, endSec: 1, text: "bonjour" }],
			granularity: "phrase",
			detectedLanguage: "fr",
		});

		const doc = makeDoc();
		const t = await transcribeAsset(doc, "asset_1", { language: "fr" });

		// The forced ISO code reaches the underlying worker call.
		expect(transcribeMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ language: "fr" }),
		);
		// The stored transcript reports the model-confirmed language.
		expect(t.language).toBe("fr");
	});

	it("omits the language option from the worker call when 'auto' so Whisper detects", async () => {
		transcribeMock.mockResolvedValueOnce({
			segments: [{ startSec: 0, endSec: 1, text: "hello" }],
			granularity: "phrase",
			detectedLanguage: "en",
		});

		const doc = makeDoc();
		const t = await transcribeAsset(doc, "asset_1", { language: "auto" });

		expect(transcribeMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ language: undefined }),
		);
		expect(t.language).toBe("en");
	});

	it("captures Whisper's auto-detected language when no option was passed", async () => {
		transcribeMock.mockResolvedValueOnce({
			segments: [{ startSec: 0, endSec: 1, text: "hola" }],
			granularity: "phrase",
			detectedLanguage: "es",
		});

		const doc = makeDoc();
		const t = await transcribeAsset(doc, "asset_1");

		expect(transcribeMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ language: undefined }),
		);
		expect(t.language).toBe("es");
	});

	it("falls back to 'auto' when the model reports no language token", async () => {
		transcribeMock.mockResolvedValueOnce({
			segments: [],
			granularity: "phrase",
			detectedLanguage: null,
		});

		const doc = makeDoc();
		const t = await transcribeAsset(doc, "asset_1");

		expect(t.language).toBe("auto");
	});
});

describe("transcribeAsset native extraction", () => {
	// Call counts are the assertion here, so they start from zero every test —
	// `mockResolvedValueOnce` queues a result, it does not clear the history.
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("hands the main process a path", async () => {
		transcribeMock.mockResolvedValueOnce({
			segments: [{ startSec: 0, endSec: 1, text: "hi" }],
			granularity: "word",
			detectedLanguage: "en",
		});
		await transcribeAsset(makeDoc(), "asset_1");
		expect(transcribeMock).toHaveBeenCalledWith("/tmp/demo.mp4", expect.anything());
	});

	it("says ffmpeg is missing instead of falling back to a renderer decode", async () => {
		// The fallback used to catch this and decode in the renderer, which the CLI's
		// hidden runner was not allowed to read: "File path is not approved or is not a
		// supported video file". Now the reason reaches the caller as the IPC delivers it.
		const missing =
			"ffmpeg is missing: transcription needs it to read the audio, and this install has none.";
		transcribeMock.mockRejectedValueOnce(
			new Error(
				`Error invoking remote method 'stt:transcribe': FfmpegUnavailableError: ${missing}`,
			),
		);
		const error = await transcribeAsset(makeDoc(), "asset_1").catch((e: unknown) => e);
		expect(transcribeMock).toHaveBeenCalledTimes(1);
		// What the CLI prints after "Transcription failed: ", and the editor shows.
		expect(classifyTranscriptionError(error)).toEqual({ kind: "error", message: missing });
	});

	it("passes the project's names and terms", async () => {
		const doc = makeDoc();
		doc.project.vocabulary = "OpenScreen, Kubernetes";
		transcribeMock.mockResolvedValueOnce({
			segments: [],
			granularity: "word",
			detectedLanguage: "en",
		});
		await transcribeAsset(doc, "asset_1");
		expect(transcribeMock).toHaveBeenCalledWith(
			"/tmp/demo.mp4",
			expect.objectContaining({ prompt: "OpenScreen, Kubernetes" }),
		);
	});
});

describe("transcribeAsset timing", () => {
	it("never writes a segment or word that ends before it starts", async () => {
		// The shape an end clamped to the audio length but not its start produced: a
		// hallucination at 13.5 s in 6.76 s of sound. Stored as is, it made the whole
		// project unreadable.
		transcribeMock.mockResolvedValueOnce({
			segments: [
				{ startSec: 13.5, endSec: 6.7626875, text: "very" },
				{ startSec: 13.5, endSec: 6.7626875, text: "good" },
			],
			granularity: "word",
			detectedLanguage: "en",
		});
		const transcript = await transcribeAsset(makeDoc(), "asset_1");
		expect(() => transcriptSchema.parse(transcript)).not.toThrow();
		expect(transcript.words.map((w) => [w.text, w.startSec, w.endSec])).toEqual([
			["very", 13.5, 13.5],
			["good", 13.5, 13.5],
		]);
	});
});
