import type { AxcutDocument } from "./schema";

/**
 * A shader effect an agent wrote (spike): WGSL defining `fn effect(uv: vec2<f32>) -> vec4<f32>`,
 * run by the compositor over the whole composed frame, in the preview and the export alike.
 * The contract is in `crates/compositor/src/shader_fx.rs`.
 *
 * Stored in `legacyEditor.shaderEffects`, in RAW timeline ms like the other regions, so the
 * document schema does not change for a spike.
 */
export interface ShaderEffectRegion {
	id: string;
	startMs: number;
	endMs: number;
	code: string;
	/** Up to eight values, read in WGSL by `param(i)`. */
	params: number[];
}

export const SHADER_EFFECT_PARAM_COUNT = 8;

export function readShaderEffects(document: AxcutDocument): ShaderEffectRegion[] {
	const legacy = document.legacyEditor as Record<string, unknown> | null;
	return (legacy?.shaderEffects as ShaderEffectRegion[] | undefined) ?? [];
}

export function withShaderEffects(
	document: AxcutDocument,
	shaderEffects: ShaderEffectRegion[],
): AxcutDocument {
	const legacy = (document.legacyEditor as Record<string, unknown> | null) ?? {};
	return { ...document, legacyEditor: { ...legacy, shaderEffects } };
}
