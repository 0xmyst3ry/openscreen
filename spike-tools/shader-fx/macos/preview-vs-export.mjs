// La vue live de l'éditeur (pilotée sans fenêtre : createView, setScene, presentTime, readFrame)
// contre l'export, sur la même scène, aux mêmes instants ; puis la cadence de la preview en
// lecture, avec et sans effet. Adapté de `spike-tools/shader-fx/preview-vs-export.mjs` (Windows).
//
//   node preview-vs-export.mjs <worktree>
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const WT = path.resolve(process.argv[2]);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const E2E = path.join(HERE, "e2e");
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
const addon = createRequire(import.meta.url)(`${WT}/electron/native/bin/darwin-arm64/compositor_view.node`);

const sceneJson = fs.readFileSync(`${E2E}/scene-effect.json`, "utf8");
const scene = JSON.parse(sceneJson);
const plainSceneJson = fs.readFileSync(`${E2E}/scene-plain.json`, "utf8");
const probe = execFileSync(process.env.FFPROBE ?? "ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,color_space,color_range", "-of", "json", `${E2E}/effect.mp4`]);
const stream = JSON.parse(probe).streams[0];
const [W, H] = [stream.width, stream.height];
console.log("export:", stream);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const screenPath = scene.clips[0].screenPath;
const id = addon.createView({ x: 0, y: 0, width: W, height: H }, screenPath, "", `${screenPath}.cursor.json`);
addon.setScene(id, sceneJson);
addon.setPlaying(id, false);
// Ce que l'éditeur pousse à la vue par `setParam` (`pushAllNativeParams`) : sans eux, le curseur
// de la preview garde sa taille par défaut et ne ressemble plus à celui de l'export.
const c = scene.cursor;
addon.setParam(id, "cursorShow", c.show);
addon.setParam(id, "cursorAutoHide", c.autoHide);
addon.setParam(id, "cursorSize", c.size);
addon.setParam(id, "cursorClickBounce", c.clickBounce);
addon.setParam(id, "cursorModel3d", c.model3d);
addon.setParam(id, "cursorSmoothing", c.smoothing);
addon.setParam(id, "cursorMotionBlur", c.motionBlur);

let gen = 0;
async function previewAt(t, settleMs = 1500) {
	addon.presentTime(id, t);
	let last = null;
	const until = Date.now() + settleMs;
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

// L'export est en BT.709 (limité) : le décoder comme tel, pas avec la matrice par défaut de swscale.
function exportFrame(file, t) {
	return execFileSync(FFMPEG, ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "scale=in_color_matrix=bt709:in_range=tv", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 64 << 20 });
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

// Les pixels que l'effet change à l'export (|effet - sans effet| > 24 sur la somme RGB), et sur
// eux seuls l'écart de la preview à chaque export : c'est là que l'effet se juge.
// On écarte les pixels où la preview et l'export divergent déjà sans effet (> 24 aussi) : ce qui
// reste mesure l'effet seul.
function inMask(preview, withFx, plain, previewPlain) {
	const mask = [];
	const far = (a, b, i) => Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24;
	let disagree = 0;
	for (let i = 0; i < withFx.length; i += 4) {
		if (!far(withFx, plain, i)) continue;
		if (far(previewPlain, plain, i)) disagree++;
		else mask.push(i);
	}
	const mean = (other) => {
		let sum = 0;
		for (const i of mask) for (let c = 0; c < 3; c++) sum += Math.abs(preview[i + c] - other[i + c]);
		return mask.length ? +(sum / (mask.length * 3)).toFixed(2) : null;
	};
	return { pixels: mask.length, excluded: disagree, "preview vs export (effet)": mean(withFx), "preview vs export sans effet": mean(plain) };
}

// L'effet lui-même dans chaque chemin (avec moins sans), sur les pixels où l'un des deux le voit :
// le bruit du codec, commun aux deux exports, s'annule pour l'essentiel.
function effectDelta(preview, previewPlain, withFx, plain) {
	let n = 0;
	let magnitude = 0;
	let mismatch = 0;
	for (let i = 0; i < withFx.length; i += 4) {
		let e = 0;
		let p = 0;
		for (let c = 0; c < 3; c++) {
			e += Math.abs(withFx[i + c] - plain[i + c]);
			p += Math.abs(preview[i + c] - previewPlain[i + c]);
		}
		if (e <= 24 && p <= 24) continue;
		n++;
		for (let c = 0; c < 3; c++) {
			magnitude += Math.abs(withFx[i + c] - plain[i + c]);
			mismatch += Math.abs(preview[i + c] - previewPlain[i + c] - (withFx[i + c] - plain[i + c]));
		}
	}
	return n ? { pixels: n, "effet à l'export": +(magnitude / (n * 3)).toFixed(2), "écart des deux effets": +(mismatch / (n * 3)).toFixed(2) } : null;
}

function savePpm(name, rgba, w, h) {
	const header = Buffer.from(`P6\n${w} ${h}\n255\n`);
	const rgb = Buffer.alloc(w * h * 3);
	for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
		rgb[j] = rgba[i];
		rgb[j + 1] = rgba[i + 1];
		rgb[j + 2] = rgba[i + 2];
	}
	fs.writeFileSync(`${E2E}/${name}.ppm`, Buffer.concat([header, rgb]));
}

const results = {};
await previewAt(0.5, 5000);
for (const t of [0.5, 1.3, 2.9, 4.5]) {
	addon.setScene(id, plainSceneJson);
	const pPlain = await previewAt(t);
	addon.setScene(id, sceneJson);
	const p = await previewAt(t);
	if (!p || p.width !== W || p.height !== H) throw new Error(`preview frame ${p?.width}x${p?.height}`);
	const withFx = exportFrame(`${E2E}/effect.mp4`, t);
	const plain = exportFrame(`${E2E}/plain.mp4`, t);
	results[t] = {
		"preview vs export (effet)": compare(p.data, withFx),
		"preview vs export sans effet": compare(p.data, plain),
		"preview sans effet vs export sans effet": compare(pPlain.data, plain),
		"là où l'effet agit": inMask(p.data, withFx, plain, pPlain.data),
		"l'effet, preview contre export": effectDelta(p.data, pPlain.data, withFx, plain),
	};
	savePpm(`preview-${t}s`, p.data, W, H);
	savePpm(`export-${t}s`, withFx, W, H);
	savePpm(`preview-plain-${t}s`, pPlain.data, W, H);
	savePpm(`export-plain-${t}s`, plain, W, H);
	for (const dt of [-1 / 30, 1 / 30]) {
		results[`${t} export décalé ${dt > 0 ? "+" : "-"}1 frame`] = compare(p.data, exportFrame(`${E2E}/effect.mp4`, t + dt));
	}
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
console.log("preview fps (source 30 i/s):", fps);
fs.writeFileSync(`${E2E}/preview-vs-export.json`, JSON.stringify({ export: stream, results, fps }, null, 1));
addon.destroyView(id);
process.exit(0);
