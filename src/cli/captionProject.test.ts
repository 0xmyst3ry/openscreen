import { describe, expect, it, vi } from "vitest";
import { getCaptionSettings } from "@/lib/ai-edition/captions";
import {
	type AxcutDocument,
	type AxcutTranscript,
	createEmptyDocument,
	documentSchema,
} from "@/lib/ai-edition/schema";
import { captionProject } from "./captionProject";

function project(extra: Partial<AxcutDocument> = {}): AxcutDocument {
	const base = createEmptyDocument({
		title: "CLI",
		projectId: "proj_1",
		createdAt: "2026-01-01T00:00:00.000Z",
	});
	return documentSchema.parse({
		...base,
		project: { ...base.project, primaryAssetId: "asset_1" },
		assets: [
			{ id: "asset_1", kind: "video", label: "Rec", originalPath: "/tmp/rec.mp4", durationSec: 10 },
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
		...extra,
	});
}

function transcript(text: string): AxcutTranscript {
	const words = text.split(" ");
	return {
		assetId: "asset_1",
		language: "en",
		segments: words.map((word, i) => ({
			id: `seg_${i + 1}`,
			kind: "speech" as const,
			startSec: i,
			endSec: i + 1,
			text: word,
			wordIds: [`word_${i + 1}`],
		})),
		words: words.map((word, i) => ({
			id: `word_${i + 1}`,
			segmentId: `seg_${i + 1}`,
			startSec: i,
			endSec: i + 1,
			text: word,
		})),
	};
}

const LINE = { minWordsPerLine: 1, maxWordsPerLine: 2 };

describe("captionProject", () => {
	it("transcribes the primary media and turns the editor's captions on", async () => {
		const transcribe = vi.fn(async () => transcript("one two three four"));
		const result = await captionProject(project(), LINE, transcribe);

		expect(transcribe).toHaveBeenCalledWith(expect.anything(), "asset_1");
		expect(result.transcribed).toBe(true);
		expect(result.document.transcripts).toHaveLength(1);
		expect(getCaptionSettings(result.document)).toMatchObject({
			enabled: true,
			minWordsPerLine: 1,
			maxWordsPerLine: 2,
		});
		expect(result.captionCount).toBe(2);
	});

	it("reuses a transcript the project has, and clears the old caption annotations", async () => {
		const withLegacy = {
			...project({ transcripts: [transcript("hello there")] }),
			annotations: [
				{ id: "annotation-1", annotationSource: "auto-caption" },
			] as unknown as AxcutDocument["annotations"],
		};
		const transcribe = vi.fn();
		const result = await captionProject(withLegacy, LINE, transcribe);

		expect(transcribe).not.toHaveBeenCalled();
		expect(result.transcribed).toBe(false);
		expect(result.document.annotations).toEqual([]);
	});

	it("copies a transcript only the legacy mirror holds where the captions read it", async () => {
		const legacy = { ...project(), transcript: transcript("one two"), transcripts: [] };
		const result = await captionProject(legacy, LINE, vi.fn());

		expect(result.document.transcripts).toHaveLength(1);
		expect(result.captionCount).toBe(1);
	});

	it("fails on media with no speech, writing nothing", async () => {
		const silent: AxcutTranscript = {
			assetId: "asset_1",
			language: "auto",
			segments: [],
			words: [],
		};
		await expect(captionProject(project(), LINE, async () => silent)).rejects.toThrow(/No speech/);
	});
});
