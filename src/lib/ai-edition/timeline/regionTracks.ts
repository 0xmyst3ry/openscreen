import { coalesceRegionsForRuler } from "./timelineMap";

// Track geometry shared by the timeline and its automatic height adjustment.
export const REGION_ROW_HEIGHT_PX = 22;
export const REGION_ROW_GAP_PX = 5;
export const REGION_LANE_PAD_PX = 1;
export const REGION_ROW_STEP_PX = REGION_ROW_HEIGHT_PX + REGION_ROW_GAP_PX;

export interface TrackSpan {
	id: string;
	start: number;
	end: number;
	/** Higher annotation layers appear above lower ones, as in the compositor. */
	layer?: number;
	/** Stable compositing order for annotations that share a saved zIndex. */
	stackOrder?: number;
}

const frontFirst = (a: TrackSpan, b: TrackSpan) =>
	(b.layer ?? 0) - (a.layer ?? 0) || (b.stackOrder ?? 0) - (a.stackOrder ?? 0);
const overlaps = (a: TrackSpan, b: { start: number; end: number }) =>
	a.start < b.end && a.end > b.start;

/** Put each annotation on the highest free row below every higher annotation it
 * overlaps. Nonoverlapping layers share rows; zoom and resize handles never add rows. */
export function packRegionRows(spans: readonly TrackSpan[]) {
	const rowOf = new Map<string, number>();
	const placed: TrackSpan[] = [];
	let rowCount = 1;
	for (const span of [...spans].sort(frontFirst)) {
		let row = 0;
		for (const higher of placed) {
			if (overlaps(higher, span)) row = Math.max(row, (rowOf.get(higher.id) ?? 0) + 1);
		}
		rowOf.set(span.id, row);
		rowCount = Math.max(rowCount, row + 1);
		placed.push(span);
	}
	return { rowOf, rowCount };
}

/** Shared pill geometry and saved tie order, used for both drawing and panel height. */
export function annotationTrackPills<
	T extends { id: string; startMs: number; endMs: number; zIndex?: number },
>(regions: T[]) {
	const order = new Map(regions.map((region, index) => [region.id, index]));
	return coalesceRegionsForRuler(regions, 0.001, { annotations: true }).map((pill) => ({
		...pill,
		id: pill.ids[0],
		layer: pill.member.zIndex,
		stackOrder: Math.max(...pill.ids.map((id) => order.get(id) ?? 0)),
	}));
}

export interface AnnotationTrackDrop {
	row: number;
	direction: "up" | "down";
}

/** Reorder relative to annotations overlapping the DROP span, on the requested row.
 * Direction resolves drops onto occupied rows, including equal saved layers. Other
 * annotations keep their relative compositing order. The same plan drives the preview
 * and the single persisted span/order change. */
export function annotationDropLayers(
	spans: readonly TrackSpan[],
	id: string,
	desired: { start: number; end: number },
	drop: AnnotationTrackDrop,
	rows = packRegionRows(spans),
) {
	const ordered = [...spans].sort(frontFirst);
	const moved = ordered.find((p) => p.id === id);
	const layers = new Map<string, number>();
	if (!moved) return layers;
	const others = ordered.filter((p) => p !== moved);
	const neighbours = others.filter((p) => overlaps(p, desired));
	if (neighbours.length === 0) return layers;
	const below = neighbours.find((p) => {
		const row = rows.rowOf.get(p.id) ?? 0;
		return drop.direction === "up" ? row >= drop.row : row > drop.row;
	});
	const insertAt = below
		? others.indexOf(below)
		: others.indexOf(neighbours[neighbours.length - 1]) + 1;
	others.splice(insertAt, 0, moved);
	// Materialize tie order as unique integer layers before rebuilding fragments.
	others.forEach((p, index) => layers.set(p.id, others.length - index - 1));
	return layers;
}

/** Height of an annotation lane, including its top/bottom inset. */
export function regionLaneHeight(rowCount: number) {
	return (
		rowCount * REGION_ROW_HEIGHT_PX + (rowCount - 1) * REGION_ROW_GAP_PX + REGION_LANE_PAD_PX * 2
	);
}
