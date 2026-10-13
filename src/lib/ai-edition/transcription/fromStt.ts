// What the speech engine answers, turned into the document's transcript. Pure, so the
// editor's queue (through the renderer) and the MCP `transcribe` tool (in the main
// process, `electron/mcp/`) build the very same words from the very same answer.

import type { SttTranscribeResponse } from "../../../../electron/stt/transcriptionContract";
import type { CaptionSegment, CaptionTimestampGranularity } from "../../captioning/transcribe";
import type { AxcutTranscript, AxcutTranscriptSegment, AxcutWord } from "../schema";

/**
 * The engine's words as timed segments, one per word. When whisper dropped every word
 * (OOV-heavy speech), its phrase spans instead, so there is still something to edit.
 */
export function segmentsFromStt(
	response: Pick<SttTranscribeResponse, "segments" | "wordSegments">,
): { segments: CaptionSegment[]; granularity: CaptionTimestampGranularity } {
	const words = response.wordSegments ?? [];
	if (words.length > 0) {
		return {
			segments: words.map((w) => ({ startSec: w.startSec, endSec: w.endSec, text: w.word })),
			granularity: "word",
		};
	}
	return {
		segments: (response.segments ?? []).map((s) => ({
			startSec: s.startSec,
			endSec: s.endSec,
			text: s.text,
		})),
		granularity: "phrase",
	};
}

/**
 * Timed segments as an asset's transcript: each segment's tokens become its words,
 * spread evenly over its span.
 *
 * `language` is what the engine settled on, or failing that what was asked for, then
 * "auto" (very rare: usually a run with no audio).
 */
export function transcriptFromSegments(
	assetId: string,
	segments: readonly CaptionSegment[],
	language: string | null | undefined,
): AxcutTranscript {
	const transcriptSegments: AxcutTranscriptSegment[] = [];
	const words: AxcutWord[] = [];

	for (const [index, seg] of segments.entries()) {
		const tokens = seg.text.trim().split(/\s+/).filter(Boolean);
		if (tokens.length === 0) continue;
		const segId = `seg_${index + 1}`;
		const wordIds: string[] = [];
		// Never end before the start: the schema rejects it, and one such word made the whole
		// project unreadable (see `raiseInvertedTranscriptEnds`, which repairs old files).
		const segEndSec = Math.max(seg.endSec, seg.startSec);
		const wordDuration = (segEndSec - seg.startSec) / tokens.length;
		for (let w = 0; w < tokens.length; w++) {
			const wordId = `word_${words.length + 1}`;
			const startSec = seg.startSec + w * wordDuration;
			words.push({
				id: wordId,
				segmentId: segId,
				startSec,
				endSec: startSec + wordDuration,
				text: tokens[w],
			});
			wordIds.push(wordId);
		}
		transcriptSegments.push({
			id: segId,
			kind: "speech" as const,
			startSec: seg.startSec,
			endSec: segEndSec,
			text: seg.text,
			wordIds,
		});
	}

	return { assetId, language: language || "auto", segments: transcriptSegments, words };
}
