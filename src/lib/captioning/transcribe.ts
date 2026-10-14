import type { TrimRegion } from "@/components/video-editor/types";
import type { SttWordSegment } from "../../../electron/stt/transcriptionContract";
import { segmentsFromStt } from "../ai-edition/transcription/fromStt";

export interface CaptionSegment {
	startSec: number;
	endSec: number;
	text: string;
}

/**
 * How caption layout should interpret `CaptionSegment` times from
 * `transcribeSourceFileToSegments`. The native pipeline gets per-word timestamps
 * from whisper.cpp's own output; `"phrase"` is a fallback for the rare case
 * where whisper reports zero words for a segment.
 */
export type CaptionTimestampGranularity = "word" | "phrase";

export interface TranscribeMono16kResult {
	segments: CaptionSegment[];
	granularity: CaptionTimestampGranularity;
	/**
	 * ISO 639-1 code Whisper settled on for the chunk stream — either the
	 * forced one (when `language` was supplied) or what it auto-detected.
	 * Null when the model produced no language token.
	 */
	detectedLanguage?: string | null;
}

export type SttRendererStatusPhase = "model" | "transcribe";

/**
 * Progress the main process reports while a transcription runs. `completedSec` /
 * `totalSec` are present only during `"transcribe"`, and only once chunking has
 * started — they let the UI show a real bar instead of an indeterminate spinner
 * for what can be several minutes of work.
 */
export interface SttRendererStatus {
	phase: SttRendererStatusPhase;
	completedSec?: number;
	totalSec?: number;
	/**
	 * Backend the helper actually bound (`"whispercpp-cpu"` when the GPU path was
	 * not taken). Reported per chunk during `"transcribe"`.
	 */
	backend?: string;
	/** Real-time factor for the run so far — wall-clock / audio, lower is faster. */
	rtf?: number;
	/** Bytes of the speech model fetched so far. Only during `"model"`. */
	downloadedBytes?: number;
	/** Total bytes of the in-flight model download. */
	totalBytes?: number;
}

interface RendererSttApi {
	transcribe: (request: { sourcePath: string; language?: string; prompt?: string }) => Promise<{
		segments: CaptionSegment[];
		wordSegments: SttWordSegment[];
		detectedLanguage: string;
		backend: string;
	}>;
	cancel?: () => Promise<void>;
	onStatus?: (callback: (event: SttRendererStatus) => void) => () => void;
}

export interface TranscribeOptions {
	trimRegions?: TrimRegion[];
	onStatus?: (status: SttRendererStatus) => void;
	signal?: AbortSignal;
	language?: string;
	/** Names and terms to bias Whisper toward (the project's vocabulary). */
	prompt?: string;
}

/**
 * Transcribes a media FILE into per-word timed caption segments. The renderer is a
 * thin IPC adapter: it sends the path, the main process decodes it with ffmpeg and
 * `whisper-server` runs recognition, emitting per-word timestamps in the same pass.
 * The renderer never holds the audio: decoding it here read the whole file, copied it
 * twice and resampled on the UI thread, which is what froze the editor at open.
 *
 * Rejects with `FfmpegUnavailableError`'s message when the install has no ffmpeg.
 * There is no renderer decode to fall back on any more.
 *
 * The previous in-Web-Worker implementation (Transformers.js + ORT-WASM) was
 * 0.5× realtime on tiny models and had no word-level accuracy under 50 ms;
 * see `technical-documentation/architecture/transcription-and-captions.md` § History for context.
 */
export function transcribeSourceFileToSegments(
	sourcePath: string,
	options?: TranscribeOptions,
): Promise<TranscribeMono16kResult> {
	if (options?.signal?.aborted) {
		return Promise.reject(new DOMException("Aborted", "AbortError"));
	}
	const api = (window as Window & { electronAPI?: { stt?: RendererSttApi } }).electronAPI?.stt;
	if (!api?.transcribe) {
		// Renderer-only fallback (browser tests, dev tooling without Electron).
		// We don't try to run any model here — the worker migration is permanent.
		return Promise.resolve({ segments: [], granularity: "word" });
	}

	const unsubscribe = options?.onStatus && api.onStatus?.((event) => options.onStatus?.(event));
	// Aborting has to reach the MAIN process: the work is a chunk loop over there,
	// and a renderer that merely stops awaiting still leaves the helper busy for
	// minutes — with the replacement request queued behind it, which is what made
	// "regenerate in another language" look dead.
	const onAbort = () => void api.cancel?.();
	options?.signal?.addEventListener("abort", onAbort, { once: true });
	const forcedLanguage =
		options?.language && options.language !== "auto" ? options.language : undefined;
	// ponytail: word timestamps come back already absolute. The helper cuts the
	// silence out itself (Silero VAD, `--vad-model`) and maps every word back
	// onto the original audio: whisper.cpp's own VAD maps segment times but not
	// word times. No trim + offset math here on purpose: an earlier iteration
	// trimmed leading silence with a peak detector and got false positives on
	// quiet music intros / room tone. VAD or nothing.
	return api
		.transcribe({ sourcePath, language: forcedLanguage, prompt: options?.prompt })
		.then((result) => ({ ...segmentsFromStt(result), detectedLanguage: result.detectedLanguage }))
		.catch((error: unknown) => {
			// A run the caller cancelled surfaces as an abort, not as an engine
			// failure: the store drops it silently instead of toasting the user
			// about something they asked for.
			if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
			throw error;
		})
		.finally(() => {
			options?.signal?.removeEventListener("abort", onAbort);
			unsubscribe?.();
		});
}
