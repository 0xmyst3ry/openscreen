import { describe, expect, it } from "vitest";
import { segmentsFromStt, transcriptFromSegments } from "./fromStt";

describe("segmentsFromStt", () => {
	it("takes the engine's words, one segment each", () => {
		const { segments, granularity } = segmentsFromStt({
			segments: [{ text: "Hi you", startSec: 0, endSec: 1 }],
			wordSegments: [
				{ word: "Hi", startSec: 0, endSec: 0.4 },
				{ word: "you", startSec: 0.4, endSec: 1 },
			],
		});
		expect(granularity).toBe("word");
		expect(segments.map((s) => s.text)).toEqual(["Hi", "you"]);
	});

	it("falls back to the phrases when whisper kept no word", () => {
		const { segments, granularity } = segmentsFromStt({
			segments: [{ text: "Hi you", startSec: 0, endSec: 1 }],
			wordSegments: [],
		});
		expect(granularity).toBe("phrase");
		expect(segments).toEqual([{ text: "Hi you", startSec: 0, endSec: 1 }]);
	});
});

describe("transcriptFromSegments", () => {
	it("spreads each segment's tokens over its span, keeping ids by position", () => {
		const transcript = transcriptFromSegments(
			"asset_1",
			[
				{ text: "  ", startSec: 0, endSec: 1 },
				{ text: "two words", startSec: 2, endSec: 3 },
			],
			"fr",
		);
		expect(transcript.language).toBe("fr");
		expect(transcript.segments.map((s) => s.id)).toEqual(["seg_2"]);
		expect(transcript.words).toEqual([
			{ id: "word_1", segmentId: "seg_2", startSec: 2, endSec: 2.5, text: "two" },
			{ id: "word_2", segmentId: "seg_2", startSec: 2.5, endSec: 3, text: "words" },
		]);
	});

	it("never ends a word before it starts, and says auto when no language came back", () => {
		const transcript = transcriptFromSegments("a", [{ text: "x", startSec: 2, endSec: 1 }], null);
		expect(transcript.language).toBe("auto");
		expect(transcript.words[0]).toMatchObject({ startSec: 2, endSec: 2 });
	});
});
