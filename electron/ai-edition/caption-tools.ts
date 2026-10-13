// The caption tools: how the captions look and where they sit, which language they show,
// and the translation layers behind that choice. Pure, like the rest of the executor
// (`agent-tools.ts` routes these names here): no IPC, no fs.
//
// The writes are the Captions pane's own (`useCaptions`): `patchCaptionSettings` at the
// document's output aspect, `putCaptionTranslation`, `removeCaptionTranslation`. The
// caller translates by itself: an MCP client and the in-app agent are both language
// models, so neither needs the app's own provider for it. The transcript is never touched.

import { z } from "zod";
import {
	CAPTION_FONT_SIZE_MAX,
	CAPTION_FONT_SIZE_MIN,
	CAPTION_INSET_X_MAX,
	CAPTION_INSET_Y_MAX,
	CAPTION_PLATE_OPACITY_MAX,
	CAPTION_PLATE_OPACITY_MIN,
	CAPTION_STYLES,
	type CaptionSettings,
	type CaptionSettingsPatch,
	type CaptionStyleId,
	captionPlateOf,
	captionPlatePatch,
	captionStyleOf,
	captionTranslationUnits,
	getCaptionSettings,
	getCaptionTranslations,
	patchCaptionSettings,
	putCaptionTranslation,
	removeCaptionTranslation,
	translationCoverage,
} from "../../src/lib/ai-edition/captions";
import { resolveCaptionLane } from "../../src/lib/ai-edition/captions/settings";
import {
	CAPTION_WORDS_PER_LINE_MAX,
	CAPTION_WORDS_PER_LINE_MIN,
} from "../../src/lib/ai-edition/captions/wordsPerLine";
import { resolveAspectRatioValue } from "../../src/lib/ai-edition/document/outputFormat";
import { VOCABULARY_MAX_CHARS, withVocabulary } from "../../src/lib/ai-edition/document/transcript";
import type { AxcutDocument, AxcutTranscript } from "../../src/lib/ai-edition/schema";
import { getEditorSettings } from "../../src/lib/ai-edition/store/editorSettings";
import { lanePlacements } from "../../src/lib/ai-edition/timeline/aggregated-transcript";
import { transcriptHasSpeech } from "../../src/lib/ai-edition/transcription/status";
import { TEXT_FONT_FAMILIES } from "../../src/lib/textFonts";
import type { AgentToolExecution } from "./agent-tools";

const STYLE_IDS = Object.keys(CAPTION_STYLES) as [CaptionStyleId, ...CaptionStyleId[]];
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "a #rrggbb colour");
const wordsPerLine = z
	.number()
	.int()
	.min(CAPTION_WORDS_PER_LINE_MIN)
	.max(CAPTION_WORDS_PER_LINE_MAX);
// A BCP 47 tag ("fr", "pt-BR"): it is the layer's storage key.
const languageCode = z
	.string()
	.regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "a language code such as fr or pt-BR");

export const getCaptionsArgs = z.object({});

export const setCaptionSettingsArgs = z.object({
	enabled: z.boolean().optional(),
	style: z.enum(STYLE_IDS).optional(),
	fontFamily: z.enum(TEXT_FONT_FAMILIES).optional(),
	fontWeight: z.enum(["normal", "bold"]).optional(),
	fontSize: z.number().min(CAPTION_FONT_SIZE_MIN).max(CAPTION_FONT_SIZE_MAX).optional(),
	color: hexColor.optional(),
	plate: z.enum(["none", "dark", "light"]).optional(),
	plateOpacity: z.number().min(CAPTION_PLATE_OPACITY_MIN).max(CAPTION_PLATE_OPACITY_MAX).optional(),
	anchorV: z.enum(["bottom", "top"]).optional(),
	anchorH: z.enum(["left", "center", "right"]).optional(),
	insetY: z.number().min(0).max(CAPTION_INSET_Y_MAX).optional(),
	insetX: z.number().min(0).max(CAPTION_INSET_X_MAX).optional(),
	minWordsPerLine: wordsPerLine.optional(),
	maxWordsPerLine: wordsPerLine.optional(),
	lane: z.enum(["recording", "voiceover"]).optional(),
	language: languageCode.nullable().optional(),
});

export const getCaptionTranslationUnitsArgs = z.object({
	language: languageCode,
	assetId: z.string().min(1).optional(),
	includeTranslated: z.boolean().optional(),
});

export const putCaptionTranslationArgs = z.object({
	language: languageCode,
	label: z.string().trim().min(1).max(40).optional(),
	assetId: z.string().min(1),
	units: z.array(z.object({ id: z.string().min(1), text: z.string().trim().min(1) })).min(1),
});

export const removeCaptionTranslationArgs = z.object({ language: languageCode });

export const setVocabularyArgs = z.object({ vocabulary: z.string().max(VOCABULARY_MAX_CHARS) });

export const CAPTION_TOOL_NAMES = [
	"getCaptions",
	"setCaptionSettings",
	"getCaptionTranslationUnits",
	"putCaptionTranslation",
	"removeCaptionTranslation",
	"setVocabulary",
] as const;

export const MUTATING_CAPTION_TOOLS = [
	"setCaptionSettings",
	"putCaptionTranslation",
	"removeCaptionTranslation",
	"setVocabulary",
] as const;

function failure(message: string): AgentToolExecution {
	return { ok: false, resultJson: JSON.stringify({ error: message }) };
}

/** The output aspect, as the Captions pane reads it: it sets the default insets. */
function aspectOf(document: AxcutDocument): number {
	return resolveAspectRatioValue(document, getEditorSettings(document).aspectRatio);
}

/** The transcripts the captions are read from: those of the media on the resolved lane. */
function captionedTranscripts(
	document: AxcutDocument,
	settings: CaptionSettings,
): AxcutTranscript[] {
	const placed = new Set(
		lanePlacements(
			resolveCaptionLane(document, settings),
			document.timeline.clips,
			document.audioTracks ?? [],
		).map((placement) => placement.assetId),
	);
	return document.transcripts.filter((t) => placed.has(t.assetId));
}

/** Everything a caller needs to read the captions back, in the editor's own terms. */
function captionsReport(document: AxcutDocument): Record<string, unknown> {
	const settings = getCaptionSettings(document, aspectOf(document));
	const transcripts = captionedTranscripts(document, settings);
	const translations = getCaptionTranslations(document);
	const nothingToCaption = transcripts.every((t) => !transcriptHasSpeech(t));
	return {
		settings,
		style: captionStyleOf(settings) ?? "custom",
		plate: captionPlateOf(settings),
		resolvedLane: resolveCaptionLane(document, settings),
		captionedAssets: transcripts.map((t) => ({
			assetId: t.assetId,
			language: t.language,
			words: t.words.length,
		})),
		...(settings.enabled && nothingToCaption
			? {
					warning:
						"Captions are on, but no transcript with speech is on their lane, so nothing shows: the media needs a transcript first (assets[].hasTranscript in getCurrentDocument).",
				}
			: {}),
		translations: Object.values(translations).map((layer) => ({
			language: layer.language,
			label: layer.label,
			updatedAt: layer.updatedAt,
			coverage: transcripts.map((t) => ({
				assetId: t.assetId,
				...translationCoverage(t, translations, layer.language),
			})),
		})),
	};
}

function hasAnyField(data: Record<string, unknown>): boolean {
	return Object.values(data).some((value) => value !== undefined);
}

export function executeCaptionTool(
	document: AxcutDocument,
	name: (typeof CAPTION_TOOL_NAMES)[number],
	args: unknown,
): AgentToolExecution {
	switch (name) {
		case "getCaptions":
			return {
				ok: true,
				resultJson: JSON.stringify({
					...captionsReport(document),
					choices: {
						styles: STYLE_IDS,
						fonts: TEXT_FONT_FAMILIES,
						plates: ["none", "dark", "light"],
					},
				}),
			};

		case "setCaptionSettings": {
			const parsed = setCaptionSettingsArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const { style, plate, plateOpacity, lane, ...fields } = parsed.data;
			if (!hasAnyField(parsed.data)) return failure("Pass at least one setting to change.");
			const aspect = aspectOf(document);
			const current = getCaptionSettings(document, aspect);
			if (fields.language) {
				const layers = Object.keys(getCaptionTranslations(document));
				if (!layers.includes(fields.language)) {
					return failure(
						`No "${fields.language}" translation to show. ${layers.length ? `This project has: ${layers.join(", ")}.` : "This project has none."} Write one with putCaptionTranslation first, or pass null for the transcript's own language.`,
					);
				}
			}
			// The pane's order: a style sets the look as a whole, a plate then recolours the
			// text that would vanish on it, and an explicit field wins over both.
			const patch: CaptionSettingsPatch = { ...(style ? CAPTION_STYLES[style] : {}) };
			if (plate) Object.assign(patch, captionPlatePatch({ ...current, ...patch }, plate));
			for (const [key, value] of Object.entries(fields)) {
				if (value !== undefined) Object.assign(patch, { [key]: value });
			}
			if (plateOpacity !== undefined) patch.backgroundOpacity = plateOpacity;
			if (lane !== undefined) patch.captionLane = lane;
			const min = patch.minWordsPerLine ?? current.minWordsPerLine;
			const max = patch.maxWordsPerLine ?? current.maxWordsPerLine;
			if (min > max) {
				return failure(
					`minWordsPerLine (${min}) cannot exceed maxWordsPerLine (${max}). Nothing was modified.`,
				);
			}
			const next = patchCaptionSettings(document, patch, aspect);
			const report = captionsReport(next);
			return {
				ok: true,
				document: next,
				resultJson: JSON.stringify({
					settings: report.settings,
					style: report.style,
					plate: report.plate,
					resolvedLane: report.resolvedLane,
					...(lane && lane !== report.resolvedLane
						? {
								laneNote: `The captions read the ${report.resolvedLane} lane: the project has no voiceover track to caption.`,
							}
						: {}),
					...(report.warning ? { warning: report.warning } : {}),
				}),
				summary:
					fields.enabled === true
						? "turned the captions on"
						: fields.enabled === false
							? "turned the captions off"
							: "restyled the captions",
			};
		}

		case "getCaptionTranslationUnits": {
			const parsed = getCaptionTranslationUnitsArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const { language, assetId, includeTranslated } = parsed.data;
			const settings = getCaptionSettings(document, aspectOf(document));
			const transcripts = assetId
				? document.transcripts.filter((t) => t.assetId === assetId)
				: captionedTranscripts(document, settings);
			if (transcripts.length === 0) {
				return failure(
					assetId
						? `Asset ${assetId} has no transcript to translate yet.`
						: "No transcript is on the captions' lane to translate yet.",
				);
			}
			const translations = getCaptionTranslations(document);
			return {
				ok: true,
				resultJson: JSON.stringify({
					language,
					assets: transcripts.map((t) => {
						const done = translations[language]?.byAsset[t.assetId] ?? {};
						const units = captionTranslationUnits(t)
							.filter((unit) => includeTranslated || !done[unit.id]?.trim())
							.map((unit) => ({
								id: unit.id,
								startSec: Math.round(unit.startSec * 1000) / 1000,
								endSec: Math.round(unit.endSec * 1000) / 1000,
								text: unit.text,
								...(done[unit.id] ? { translation: done[unit.id] } : {}),
							}));
						return {
							assetId: t.assetId,
							sourceLanguage: t.language,
							coverage: translationCoverage(t, translations, language),
							units,
						};
					}),
				}),
			};
		}

		case "putCaptionTranslation": {
			const parsed = putCaptionTranslationArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const { language, label, assetId, units } = parsed.data;
			const transcript = document.transcripts.find((t) => t.assetId === assetId);
			if (!transcript) return failure(`Asset ${assetId} has no transcript to translate.`);
			const ids = units.map((unit) => unit.id);
			const known = new Set(captionTranslationUnits(transcript).map((unit) => unit.id));
			const unknown = ids.filter((id) => !known.has(id));
			if (unknown.length > 0) {
				return failure(
					`Unknown unit id(s) for asset ${assetId}: ${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? ` and ${unknown.length - 5} more` : ""}. Take the ids from getCaptionTranslationUnits. Nothing was modified.`,
				);
			}
			if (new Set(ids).size !== ids.length) {
				return failure("A unit id is given twice. Nothing was modified.");
			}
			const next = putCaptionTranslation(document, {
				language,
				label: label ?? getCaptionTranslations(document)[language]?.label ?? language,
				assetId,
				segments: Object.fromEntries(units.map((unit) => [unit.id, unit.text])),
			});
			const shown = getCaptionSettings(next, aspectOf(next)).language === language;
			return {
				ok: true,
				document: next,
				resultJson: JSON.stringify({
					language,
					assetId,
					written: ids.length,
					coverage: translationCoverage(transcript, getCaptionTranslations(next), language),
					shown,
					...(shown
						? {}
						: {
								next: "The captions still show another language: setCaptionSettings with this language shows it.",
							}),
				}),
				summary: `translated ${ids.length} caption unit${ids.length === 1 ? "" : "s"} into ${language}`,
			};
		}

		case "removeCaptionTranslation": {
			const parsed = removeCaptionTranslationArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const { language } = parsed.data;
			const layers = Object.keys(getCaptionTranslations(document));
			if (!layers.includes(language)) {
				return failure(
					`No "${language}" translation to remove. ${layers.length ? `This project has: ${layers.join(", ")}.` : "This project has none."}`,
				);
			}
			// As the pane deletes one: captions showing it fall back to the transcript's language.
			const aspect = aspectOf(document);
			const cleared = removeCaptionTranslation(document, language);
			const next =
				getCaptionSettings(cleared, aspect).language === language
					? patchCaptionSettings(cleared, { language: null }, aspect)
					: cleared;
			return {
				ok: true,
				document: next,
				resultJson: JSON.stringify({
					removed: language,
					shownLanguage: getCaptionSettings(next, aspect).language,
				}),
				summary: `removed the ${language} caption translation`,
			};
		}

		case "setVocabulary": {
			const parsed = setVocabularyArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const next = withVocabulary(document, parsed.data.vocabulary);
			const vocabulary = (next ?? document).project.vocabulary ?? "";
			const resultJson = JSON.stringify({
				vocabulary,
				note: "Whisper reads it on the next transcription. An existing transcript is unchanged: transcribe with a language redoes it.",
			});
			return next
				? { ok: true, document: next, resultJson, summary: "set the project vocabulary" }
				: { ok: true, resultJson };
		}
	}
}
