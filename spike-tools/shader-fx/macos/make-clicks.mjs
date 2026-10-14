// Une mire de 6 s en 1920×1080 à 30 i/s, et à côté une piste curseur (`<video>.cursor.json`) qui
// glisse entre trois clics. Repris du spike (`spike-tools/shader-fx/make-clicks.mjs`).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const MEDIA = path.join(HERE, "media");
const VIDEO = path.join(MEDIA, "clicks.mp4");
fs.mkdirSync(MEDIA, { recursive: true });
execFileSync(process.env.FFMPEG ?? "ffmpeg", [
	"-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=6",
	"-c:v", "h264_videotoolbox", "-q:v", "65", "-pix_fmt", "nv12", VIDEO,
]);

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
fs.writeFileSync(`${VIDEO}.cursor.json`, JSON.stringify({ version: 2, provider: "native", samples, assets: [] }));
console.log(VIDEO, samples.length, "samples,", clicks.length, "clicks");
