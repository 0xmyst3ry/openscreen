// La preview (LiveView, la vue live de l'éditeur, pilotée sans fenêtre) contre l'export, sur la
// même scène, aux mêmes instants. Puis la cadence de la preview en lecture, avec et sans effet.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const WT = "C:/Users/etien/Documents/repos/openscreen/.claude/worktrees/custom-shader-fx-spike";
const HERE = "C:/Users/etien/AppData/Local/Temp/claude/C--Users-etien-Documents-repos-openscreen/5ab28e90-5aed-42e2-90c1-3a8ecc0eeec1/scratchpad/fx";
const FFBIN = `${WT}/crates/thirdparty/ffmpeg-n8.1.2-win64-lgpl-shared/bin`;
process.env.PATH = `${FFBIN.replaceAll("/", "\\")};${process.env.PATH}`;
const addon = createRequire(import.meta.url)(`${WT}/electron/native/bin/win32-x64/compositor_view.node`);

const sceneJson = fs.readFileSync(`${HERE}/e2e/scene.json`, "utf8");
const scene = JSON.parse(sceneJson);
const plainSceneJson = JSON.stringify({ ...scene, shaderEffects: [] });
const [W, H] = [1752, 1080];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const id = addon.createView({ x: 0, y: 0, width: W, height: H }, scene.clips[0].screenPath, "", undefined);
addon.setScene(id, sceneJson);
addon.setPlaying(id, false);

let gen = 0;
async function previewAt(t) {
	addon.presentTime(id, t);
	let last = null;
	const until = Date.now() + 1500;
	while (Date.now() < until) {
		const f = addon.readFrame(id, gen);
		if (f) {
			gen = f.gen;
			last = f;
		}
		await sleep(5);
	}
	return last;
}

function exportFrame(file, t) {
	return execFileSync(`${FFBIN}/ffmpeg.exe`, ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", process.env.MATRIX ?? "null", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 64 << 20 });
}

function compare(a, b) {
	let sum = 0;
	let sq = 0;
	let n = 0;
	for (let i = 0; i < a.length; i += 4) {
		for (let c = 0; c < 3; c++) {
			const d = a[i + c] - b[i + c];
			sum += Math.abs(d);
			sq += d * d;
			n++;
		}
	}
	const mse = sq / n;
	return { meanAbs: +(sum / n).toFixed(2), psnr: +(10 * Math.log10((255 * 255) / mse)).toFixed(1) };
}

function savePpm(name, rgba, w, h) {
	const header = Buffer.from(`P6\n${w} ${h}\n255\n`);
	const rgb = Buffer.alloc(w * h * 3);
	for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
		rgb[j] = rgba[i];
		rgb[j + 1] = rgba[i + 1];
		rgb[j + 2] = rgba[i + 2];
	}
	fs.writeFileSync(`${HERE}/e2e/${name}.ppm`, Buffer.concat([header, rgb]));
}

const results = {};
for (const t of [0.5, 2, 3, 4.5]) {
	const p = await previewAt(t);
	if (!p || p.width !== W || p.height !== H) throw new Error(`preview frame ${p?.width}x${p?.height}`);
	const withFx = exportFrame(`${HERE}/e2e/effect.mp4`, t);
	const plain = exportFrame(`${HERE}/e2e/plain.mp4`, t);
	results[t] = {
		"preview vs export (effet)": compare(p.data, withFx),
		"preview vs export sans effet": compare(p.data, plain),
	};
	savePpm(`preview-${t}s`, p.data, W, H);
	for (const dt of [-1/30, 1/30]) results[`${t} export decale ${dt > 0 ? "+" : "-"}1 frame`] = compare(p.data, exportFrame(`${HERE}/e2e/effect.mp4`, t + dt));
}
console.log(JSON.stringify(results, null, 1));

// Cadence de la preview en lecture, 3 s de 1.0 à 4.0 (dans la région), avec puis sans effet.
async function playbackFps(json) {
	addon.setScene(id, json);
	await previewAt(1.0);
	addon.setPlaying(id, true);
	const t0 = Date.now();
	let frames = 0;
	while (Date.now() - t0 < 3000) {
		const f = addon.readFrame(id, gen);
		if (f) {
			gen = f.gen;
			frames++;
		}
		await sleep(2);
	}
	addon.setPlaying(id, false);
	return +(frames / 3).toFixed(1);
}
const fps = {};
for (let round = 0; round < 2; round++) {
	fps[`avec effet #${round + 1}`] = await playbackFps(sceneJson);
	fps[`sans effet #${round + 1}`] = await playbackFps(plainSceneJson);
}
console.log("preview fps (source 30 fps):", fps);
addon.destroyView(id);
process.exit(0);
