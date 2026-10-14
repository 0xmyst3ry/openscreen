// Une copie de la mire avec une piste curseur : glisse entre trois clics, comme `pointerSamples`.
import fs from "node:fs";

const HERE = "C:/Users/etien/AppData/Local/Temp/claude/C--Users-etien-Documents-repos-openscreen/5ab28e90-5aed-42e2-90c1-3a8ecc0eeec1/scratchpad/fx/media";
fs.copyFileSync(`${HERE}/demo.mp4`, `${HERE}/clicks.mp4`);

const clicks = [
	{ t: 1000, x: 0.3, y: 0.35 },
	{ t: 2600, x: 0.7, y: 0.55 },
	{ t: 4200, x: 0.45, y: 0.75 },
];
const STEP = 16;
const TRAVEL = 600;
const samples = [];
const sample = (timeMs, cx, cy, interactionType = "move") =>
	samples.push({ timeMs: Math.round(timeMs), cx, cy, visible: true, assetId: null, cursorType: null, interactionType });
let from = { t: 0, x: 0.5, y: 0.5 };
for (const c of clicks) {
	const glide = Math.max(from.t, c.t - TRAVEL);
	for (let s = from.t; s < glide; s += STEP) sample(s, from.x, from.y);
	for (let s = glide; s < c.t; s += STEP) {
		const k = (s - glide) / (c.t - glide);
		const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
		sample(s, from.x + (c.x - from.x) * e, from.y + (c.y - from.y) * e);
	}
	sample(c.t, c.x, c.y, "click");
	sample(c.t + 80, c.x, c.y, "mouseup");
	from = { t: c.t + 80, x: c.x, y: c.y };
}
for (let s = from.t + STEP; s <= 6000; s += STEP) sample(s, from.x, from.y);
fs.writeFileSync(`${HERE}/clicks.mp4.cursor.json`, JSON.stringify({ version: 2, provider: "native", samples, assets: [] }));
console.log(samples.length, "samples,", clicks.length, "clicks");
