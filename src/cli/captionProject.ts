// What `openscreen captions` does to a project, kept out of the runner window so it is
// testable: the editor's own captions, not annotations. The primary media gets a
// transcript (the one it has, or a fresh one), then the captions are turned on with the
// requested line length, as the Captions pane would. They are the transcript drawn at
// render time, so `openscreen export` burns them in and the editor shows them editable.

import {
	deriveCaptionCues,
	getCaptionSettings,
	getCaptionTranslations,
	patchCaptionSettings,
} from "@/lib/ai-edition/captions";
import { resolveAspectRatioValue } from "@/lib/ai-edition/document/outputFormat";
import { applyTranscriptionResult } from "@/lib/ai-edition/document/transcript";
import type { AxcutDocument, AxcutTranscript } from "@/lib/ai-edition/schema";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { findAssetTranscript, transcriptHasSpeech } from "@/lib/ai-edition/transcription/status";

export interface CaptionProjectOptions {
	minWordsPerLine: number;
	maxWordsPerLine: number;
}

export async function captionProject(
	document: AxcutDocument,
	options: CaptionProjectOptions,
	transcribe: (document: AxcutDocument, assetId: string) => Promise<AxcutTranscript>,
): Promise<{ document: AxcutDocument; captionCount: number; transcribed: boolean }> {
	const assetId = document.project.primaryAssetId ?? document.assets[0]?.id;
	if (!assetId) throw new Error("Project file does not reference any recorded media");
	const existing = findAssetTranscript(document, assetId);
	const transcript = existing ?? (await transcribe(document, assetId));
	if (!transcriptHasSpeech(transcript)) {
		throw new Error("No speech detected in the project's audio");
	}
	// A transcript only in the legacy `transcript` mirror is copied into `transcripts`, which the
	// captions read.
	const stored = document.transcripts.some((t) => t.assetId === assetId);
	const transcribed = stored ? document : applyTranscriptionResult(document, transcript).document;
	// The v1 caption annotations this command used to write: the Captions pane offers to
	// clear them, and next to real captions they would show every line twice.
	const cleared: AxcutDocument = {
		...transcribed,
		annotations: transcribed.annotations.filter((a) => a.annotationSource !== "auto-caption"),
	};
	const aspect = resolveAspectRatioValue(cleared, getEditorSettings(cleared).aspectRatio);
	const next = patchCaptionSettings(
		cleared,
		{
			enabled: true,
			minWordsPerLine: options.minWordsPerLine,
			maxWordsPerLine: options.maxWordsPerLine,
		},
		aspect,
	);
	const captionCount = deriveCaptionCues(
		next,
		getCaptionSettings(next, aspect),
		getCaptionTranslations(next),
	).length;
	return { document: next, captionCount, transcribed: !existing };
}
