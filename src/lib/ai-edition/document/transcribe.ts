// Adapter: wraps OpenScreen's existing local Whisper pipeline (transformers.js,
// src/lib/captioning/) as a transcribeAsset function that returns an
// AxcutTranscript and persists it into the document.
//
// ponytail: reuses transcribeSourceFileToSegments verbatim. No Python, no
// faster-whisper, no network calls. Privacy-safe.

import { transcribeSourceFileToSegments } from "@/lib/captioning";
import type { SttRendererStatus } from "@/lib/captioning/transcribe";
import type { AxcutDocument, AxcutTranscript } from "../schema";
import { transcriptFromSegments } from "../transcription/fromStt";

/**
 * What the caller can show while a transcription runs. `completedSec` /
 * `totalSec` arrive only during `"transcribing"`, once the main process starts
 * landing chunks — until then the phase alone is all there is to show.
 */
export interface TranscribeStatus {
	phase: "extracting-audio" | "loading-model" | "transcribing";
	completedSec?: number;
	totalSec?: number;
	/** Backend the helper bound for this run; `"whispercpp-cpu"` is the slow path. */
	backend?: string;
	/** Real-time factor for the run so far — wall-clock / audio, lower is faster. */
	rtf?: number;
	/** Bytes of the speech model fetched so far. Only during `"loading-model"`. */
	downloadedBytes?: number;
	/** Total bytes of the in-flight model download. */
	totalBytes?: number;
}

export interface TranscribeAssetOptions {
	language?: string;
	onStatus?: (status: TranscribeStatus) => void;
	signal?: AbortSignal;
}

export async function transcribeAsset(
	document: AxcutDocument,
	assetId: string,
	options: TranscribeAssetOptions = {},
): Promise<AxcutTranscript> {
	const asset = document.assets.find((a) => a.id === assetId);
	if (!asset) {
		throw new Error(`Asset ${assetId} not found in document.`);
	}

	options.onStatus?.({ phase: "extracting-audio" });

	// Stay on loading-model until the main process reports inference chunks.
	// Emitting "transcribing" here used to label the cold `server.start()` wait
	// as if recognition had begun.
	options.onStatus?.({ phase: "loading-model" });
	// Only pass `language` to the worker when the caller forced a specific
	// code. `"auto"` (or any falsy value) leaves Whisper to detect from
	// the audio. The pipeline tags every chunk with the language it used
	// (forced or detected) and we read it back via `result.detectedLanguage`
	// so the stored transcript reflects reality, not the input option.
	const forcedLanguage =
		options.language && options.language !== "auto" ? options.language : undefined;
	// The project's names and terms ride along on every run, background or manual.
	const prompt = document.project.vocabulary;

	// Forward the main process's per-chunk progress. Without this the status
	// callback only ever fired the two coarse phases above, so a 30-minute
	// recording showed one static "transcribing" for ten minutes.
	const forwardStatus = (status: SttRendererStatus) =>
		options.onStatus?.({
			phase: status.phase === "model" ? "loading-model" : "transcribing",
			completedSec: status.completedSec,
			totalSec: status.totalSec,
			// Which device is doing the work, and how fast. The main process is the
			// only place that knows either, and a silent CPU fallback is exactly the
			// case a user cannot otherwise diagnose.
			backend: status.backend,
			rtf: status.rtf,
			...(status.downloadedBytes !== undefined ? { downloadedBytes: status.downloadedBytes } : {}),
			...(status.totalBytes !== undefined ? { totalBytes: status.totalBytes } : {}),
		});

	// The main process decodes the file with ffmpeg; the renderer never holds the audio.
	// No renderer decode behind it: that path read the whole file on the UI thread,
	// and the CLI's hidden runner was not even allowed to read it. Every package ships
	// ffmpeg, so a missing one surfaces as `FfmpegUnavailableError`'s message, which
	// says so, in the editor, the CLI and MCP alike.
	const result = await transcribeSourceFileToSegments(asset.originalPath, {
		trimRegions: [],
		signal: options.signal,
		language: forcedLanguage,
		prompt,
		onStatus: forwardStatus,
	});

	// Prefer the model-reported language (covers both forced picks and auto-detect),
	// then the input option.
	return transcriptFromSegments(
		assetId,
		result.segments,
		result.detectedLanguage ?? options.language,
	);
}

// `withTranscript` used to live here. It moved to `document/transcript.ts`, next to
// the other writers of the same object: it is a pure document operation, and the
// Whisper adapter is not where a caller should have to look for it.
