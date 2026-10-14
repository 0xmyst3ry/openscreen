import { describe, expect, it } from "vitest";
import {
	annotationDropLayers,
	annotationTrackPills,
	packRegionRows,
	regionLaneHeight,
} from "./regionTracks";

describe("region tracks", () => {
	it("keeps nested and identical spans independently reachable", () => {
		const tracks = packRegionRows([
			{ id: "background", start: 0, end: 67 },
			{ id: "second", start: 35, end: 40 },
			{ id: "third", start: 35, end: 40 },
		]);
		expect(tracks.rowCount).toBe(3);
		expect(new Set(tracks.rowOf.values()).size).toBe(3);
		expect(regionLaneHeight(tracks.rowCount)).toBe(78);
	});

	it("reuses rows for nonoverlapping elements regardless of their saved layers", () => {
		const tracks = packRegionRows([
			{ id: "low", start: 0, end: 2, layer: 1 },
			{ id: "high", start: 0, end: 2, layer: 10 },
			{ id: "later", start: 2, end: 4, layer: 10 },
		]);
		expect(tracks.rowCount).toBe(2);
		expect(tracks.rowOf.get("high")).toBe(0);
		expect(tracks.rowOf.get("later")).toBe(0);
		expect(tracks.rowOf.get("low")).toBe(1);
	});

	it("packs ten back-to-back annotations with unique saved layers into one row", () => {
		const spans = Array.from({ length: 10 }, (_, i) => ({
			id: String(i),
			start: i / 10,
			end: (i + 1) / 10,
			layer: i + 1,
		}));
		expect(packRegionRows(spans).rowCount).toBe(1);
	});

	it("places a lower annotation below every higher annotation it overlaps", () => {
		const tracks = packRegionRows([
			{ id: "top", start: 0, end: 2, layer: 3 },
			{ id: "middle", start: 1, end: 4, layer: 2 },
			{ id: "bottom", start: 3, end: 5, layer: 1 },
		]);
		expect([...tracks.rowOf.entries()]).toEqual([
			["top", 0],
			["middle", 1],
			["bottom", 2],
		]);
	});

	it("uses saved tie order consistently for drawing and height, independent of start order", () => {
		const spans = annotationTrackPills([
			{ id: "back", startMs: 3000, endMs: 5000, zIndex: 1 },
			{ id: "middle", startMs: 1000, endMs: 4000, zIndex: 1 },
			{ id: "front", startMs: 0, endMs: 2000, zIndex: 1 },
		]);
		const tracks = packRegionRows(spans);
		expect(tracks.rowCount).toBe(3);
		expect(tracks.rowOf.get("back")).toBe(2);
	});

	it("drops down below an occupied row even when annotations share a saved layer", () => {
		const spans = [
			{ id: "back", start: 0, end: 10, layer: 1, stackOrder: 0 },
			{ id: "front", start: 0, end: 10, layer: 1, stackOrder: 1 },
		];
		const layers = annotationDropLayers(
			spans,
			"front",
			{ start: 0, end: 10 },
			{ row: 1, direction: "down" },
		);
		expect(layers.get("front")).toBeLessThan(layers.get("back") ?? 0);
	});

	it("reorders against overlaps at the horizontal drop position", () => {
		const spans = [
			{ id: "left", start: 0, end: 10, layer: 100 },
			{ id: "right", start: 20, end: 30, layer: 1 },
			{ id: "moving", start: 0, end: 10, layer: 50 },
		];
		const layers = annotationDropLayers(
			spans,
			"moving",
			{ start: 20, end: 30 },
			{ row: 0, direction: "up" },
		);
		expect(layers.get("moving")).toBeGreaterThan(layers.get("right") ?? 0);
		expect(layers.get("left")).toBeGreaterThan(layers.get("moving") ?? 0);
		expect(
			annotationDropLayers(spans, "moving", { start: 40, end: 50 }, { row: 0, direction: "up" })
				.size,
		).toBe(0);
	});

	it("keeps one empty track for the add-element hint", () => {
		expect(packRegionRows([]).rowCount).toBe(1);
		expect(regionLaneHeight(1)).toBe(24);
	});

	it("matches compositing order for legacy annotations sharing a layer", () => {
		const tracks = packRegionRows([
			{ id: "back", start: 0, end: 67, layer: 1, stackOrder: 0 },
			{ id: "front", start: 35, end: 40, layer: 1, stackOrder: 1 },
			{ id: "later", start: 45, end: 50, layer: 1, stackOrder: 2 },
		]);
		expect(tracks.rowOf.get("front")).toBe(0);
		expect(tracks.rowOf.get("back")).toBe(1);
		expect(tracks.rowOf.get("later")).toBe(0);
	});
});
