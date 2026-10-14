import { describe, expect, it } from "vitest";
import type { AxcutDocument, AxcutShaderEffect, AxcutShaderEffectRange } from "./schema";
import { createEmptyDocument } from "./schema";
import { withPastedShaderEffect } from "./shaderEffects";

const definition: AxcutShaderEffect = {
	id: "fx_1",
	name: "Dim",
	description: "",
	contract: 1,
	code: "fn effect(uv: vec2<f32>) -> vec4<f32> { return frame(uv); }",
	params: [],
	origin: "agent",
};
const fragment = (id: string, startMs: number, endMs: number): AxcutShaderEffectRange => ({
	id,
	startMs,
	endMs,
	effectId: "fx_1",
	values: {},
	target: "image",
});

describe("withPastedShaderEffect", () => {
	const empty: AxcutDocument = createEmptyDocument({ projectId: "p", title: "t" });

	it("recreates the definition in a project that does not have it", () => {
		const next = withPastedShaderEffect(empty, definition, [fragment("fxr_1", 0, 1000)]);
		expect(next?.shaderEffects).toEqual([definition]);
		expect(next?.shaderEffectRanges).toHaveLength(1);
	});

	it("reuses the definition the project already has, and refuses a paste onto an effect", () => {
		const doc = withPastedShaderEffect(empty, definition, [
			fragment("fxr_1", 0, 1000),
		]) as AxcutDocument;
		const again = withPastedShaderEffect(doc, definition, [fragment("fxr_2", 2000, 3000)]);
		expect(again?.shaderEffects).toHaveLength(1);
		expect(again?.shaderEffectRanges).toHaveLength(2);
		expect(withPastedShaderEffect(doc, definition, [fragment("fxr_3", 500, 1500)])).toBeNull();
	});
});
