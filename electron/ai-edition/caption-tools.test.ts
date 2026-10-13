// The caption tools end to end on a document: turn them on, style and place them,
// translate them as a client would, and check the export draws what was asked.

import { describe, expect, it } from "vitest";
import { CAPTION_STYLES, getCaptionSettings } from "../../src/lib/ai-edition/captions";
import {
	type AxcutDocument,
	createEmptyDocument,
	documentSchema,
} from "../../src/lib/ai-edition/schema";
import { buildSceneDescription } from "../../src/native/sceneDescription";
import { type AgentToolExecution, executeAgentTool } from "./agent-tools";

function fixtureDocument(): AxcutDocument {
	const base = createEmptyDocument({
		title: "Captions",
		projectId: "proj_1",
		createdAt: "2026-01-01T00:00:00.000Z",
	});
	const words = [
		["w1", "Hello", 0, 0.4],
		["w2", "there.", 0.4, 0.8],
		["w3", "Second", 2, 2.4],
		["w4", "phrase.", 2.4, 2.8],
	] as const;
	return documentSchema.parse({
		...base,
		project: { ...base.project, primaryAssetId: "asset_1" },
		assets: [
			{ id: "asset_1", kind: "video", label: "Rec", originalPath: "/tmp/rec.mp4", durationSec: 10 },
		],
		// One segment per word, as Whisper's transcripts are stored.
		transcripts: [
			{
				assetId: "asset_1",
				language: "en",
				segments: words.map(([id, text, startSec, endSec]) => ({
					id: `seg_${id}`,
					kind: "speech",
					startSec,
					endSec,
					text,
					wordIds: [id],
				})),
				words: words.map(([id, text, startSec, endSec]) => ({
					id,
					segmentId: `seg_${id}`,
					startSec,
					endSec,
					text,
				})),
			},
		],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "clip_1",
					assetId: "asset_1",
					sourceStartSec: 0,
					sourceEndSec: 10,
					timelineStartSec: 0,
					timelineEndSec: 10,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
		},
	});
}

function call(document: AxcutDocument, name: string, args: unknown = {}) {
	const execution: AgentToolExecution = executeAgentTool(document, name, JSON.stringify(args));
	return { ...execution, result: JSON.parse(execution.resultJson) as Record<string, unknown> };
}

function captionTexts(document: AxcutDocument): string[] {
	return buildSceneDescription(document).annotations.map((a) => a.text?.content ?? "");
}

describe("setCaptionSettings", () => {
	it("turns the captions on, and the export draws the transcript", () => {
		const doc = fixtureDocument();
		expect(captionTexts(doc)).toEqual([]);
		const on = call(doc, "setCaptionSettings", { enabled: true });
		expect(on.ok).toBe(true);
		expect(on.document && captionTexts(on.document).join(" ")).toContain("Hello there.");
	});

	it("applies a style, then a plate, then the explicit fields over both", () => {
		const doc = fixtureDocument();
		const set = call(doc, "setCaptionSettings", {
			style: "bold",
			plate: "light",
			fontSize: 72,
			anchorV: "top",
			insetY: 8,
			minWordsPerLine: 3,
			maxWordsPerLine: 5,
		});
		const settings = getCaptionSettings(set.document);
		expect(settings.fontFamily).toBe(CAPTION_STYLES.bold.fontFamily);
		expect(settings.fontSize).toBe(72);
		expect(settings.backgroundColor).toBe("#ffffff");
		// The bold style's yellow would vanish on a light plate: the plate recoloured it.
		expect(settings.color).not.toBe(CAPTION_STYLES.bold.color);
		expect(settings).toMatchObject({ anchorV: "top", insetY: 8, minWordsPerLine: 3 });
		expect(set.result.plate).toBe("light");
	});

	it("refuses what the pane cannot express, and changes nothing", () => {
		const doc = fixtureDocument();
		expect(call(doc, "setCaptionSettings", {}).ok).toBe(false);
		expect(call(doc, "setCaptionSettings", { minWordsPerLine: 9, maxWordsPerLine: 3 }).ok).toBe(
			false,
		);
		expect(call(doc, "setCaptionSettings", { fontSize: 500 }).ok).toBe(false);
		expect(call(doc, "setCaptionSettings", { fontFamily: "Comic Sans" }).ok).toBe(false);
		const missing = call(doc, "setCaptionSettings", { language: "fr" });
		expect(missing.ok).toBe(false);
		expect(String(missing.result.error)).toContain("putCaptionTranslation");
	});

	it("reports the lane the captions really read", () => {
		const set = call(fixtureDocument(), "setCaptionSettings", { lane: "voiceover" });
		expect(set.result.resolvedLane).toBe("recording");
		expect(set.result.laneNote).toBeDefined();
	});
});

describe("getCaptions", () => {
	it("reads the settings back, warns when there is nothing to caption", () => {
		const doc = call(fixtureDocument(), "setCaptionSettings", { enabled: true }).document;
		if (!doc) throw new Error("not applied");
		const read = call(doc, "getCaptions").result;
		expect(read).toMatchObject({ style: "classic", plate: "dark", resolvedLane: "recording" });
		expect(read.warning).toBeUndefined();
		const silent = call({ ...doc, transcripts: [], transcript: null }, "getCaptions").result;
		expect(silent.warning).toBeDefined();
	});
});

describe("translating the captions", () => {
	it("reads phrase units, stores the client's translation, and the export shows it", () => {
		let doc = fixtureDocument();
		const units = call(doc, "getCaptionTranslationUnits", { language: "fr" }).result
			.assets as Array<{
			units: Array<{ id: string; text: string }>;
		}>;
		// Phrases, not words: one unit per sentence.
		expect(units[0]?.units.map((u) => u.text)).toEqual(["Hello there.", "Second phrase."]);
		const [first, second] = units[0]?.units ?? [];

		const put = call(doc, "putCaptionTranslation", {
			language: "fr",
			label: "Français",
			assetId: "asset_1",
			units: [{ id: first.id, text: "Bonjour." }],
		});
		expect(put.result).toMatchObject({
			written: 1,
			coverage: { translated: 1, total: 2 },
			shown: false,
		});
		doc = put.document ?? doc;

		// Only what is left to translate comes back.
		const left = call(doc, "getCaptionTranslationUnits", { language: "fr" }).result
			.assets as Array<{
			units: Array<{ id: string }>;
		}>;
		expect(left[0]?.units.map((u) => u.id)).toEqual([second.id]);

		doc = call(doc, "setCaptionSettings", { enabled: true, language: "fr" }).document ?? doc;
		expect(captionTexts(doc).join(" ")).toContain("Bonjour.");
		// The transcript itself is untouched.
		expect(doc.transcripts[0]?.words[0]?.text).toBe("Hello");

		const read = call(doc, "getCaptions").result.translations as Array<Record<string, unknown>>;
		expect(read).toEqual([
			expect.objectContaining({
				language: "fr",
				label: "Français",
				coverage: [{ assetId: "asset_1", translated: 1, total: 2 }],
			}),
		]);
	});

	it("refuses unit ids it does not know, and nothing is written", () => {
		const put = call(fixtureDocument(), "putCaptionTranslation", {
			language: "fr",
			assetId: "asset_1",
			units: [{ id: "seg_w1", text: "Bonjour" }],
		});
		expect(put.ok).toBe(false);
		expect(put.document).toBeUndefined();
		const twice = call(fixtureDocument(), "putCaptionTranslation", {
			language: "fr",
			assetId: "asset_1",
			units: [
				{ id: "u:seg_w1", text: "Bonjour." },
				{ id: "u:seg_w1", text: "Salut." },
			],
		});
		expect(twice.ok).toBe(false);
	});

	it("removing the language on screen puts the original back", () => {
		let doc = fixtureDocument();
		doc =
			call(doc, "putCaptionTranslation", {
				language: "fr",
				assetId: "asset_1",
				units: [{ id: "u:seg_w1", text: "Bonjour." }],
			}).document ?? doc;
		doc = call(doc, "setCaptionSettings", { language: "fr" }).document ?? doc;
		const removed = call(doc, "removeCaptionTranslation", { language: "fr" });
		expect(removed.result.shownLanguage).toBeNull();
		expect(call(removed.document ?? doc, "removeCaptionTranslation", { language: "fr" }).ok).toBe(
			false,
		);
	});
});

describe("setVocabulary", () => {
	it("stores the names Whisper is primed with, and getCurrentDocument reads them", () => {
		const set = call(fixtureDocument(), "setVocabulary", { vocabulary: "  OpenScreen, Vulkan " });
		expect(set.document?.project.vocabulary).toBe("OpenScreen, Vulkan");
		const read = set.document && call(set.document, "getCurrentDocument").result;
		expect(read?.vocabulary).toBe("OpenScreen, Vulkan");
		expect(call(fixtureDocument(), "setVocabulary", { vocabulary: "x".repeat(601) }).ok).toBe(
			false,
		);
	});
});
