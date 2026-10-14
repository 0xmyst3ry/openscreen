// Temps d'export natif (exportMulti, le chemin de l'app) avec et sans effet, passes alternées.
import fs from "node:fs";
import { createRequire } from "node:module";

const WT = "C:/Users/etien/Documents/repos/openscreen/.claude/worktrees/custom-shader-fx-spike";
const HERE = "C:/Users/etien/AppData/Local/Temp/claude/C--Users-etien-Documents-repos-openscreen/5ab28e90-5aed-42e2-90c1-3a8ecc0eeec1/scratchpad/fx";
process.env.PATH = `${WT.replaceAll("/", "\\")}\\crates\\thirdparty\\ffmpeg-n8.1.2-win64-lgpl-shared\\bin;${process.env.PATH}`;
const addon = createRequire(import.meta.url)(`${WT}/electron/native/bin/win32-x64/compositor_view.node`);

const scene = JSON.parse(fs.readFileSync(`${HERE}/e2e/scene.json`, "utf8"));
// L'effet sur toute la vidéo, pour que chaque frame le paie.
const full = { ...scene, shaderEffects: scene.shaderEffects.map((e) => ({ ...e, startSec: 0, endSec: 6 })) };
const plain = { ...scene, shaderEffects: [] };
const heavy = fs.readFileSync(`${HERE}/heavy.wgsl`, "utf8");
const heavyScene = { ...full, shaderEffects: full.shaderEffects.map((e) => ({ ...e, code: heavy })) };
const clips = scene.clips;

const runs = { "sans effet": [], "effet de l'agent": [], "effet lourd": [] };
for (let round = 0; round < 4; round++) {
	for (const [name, s] of [["sans effet", plain], ["effet de l'agent", full], ["effet lourd", heavyScene]]) {
		for (const [w, h] of [[1752, 1080]]) {
			const stats = await addon.exportMulti(clips, `${HERE}/e2e/t.mp4`, JSON.stringify(s), { width: w, height: h, fps: 30 });
			if (round > 0) runs[name].push(stats.wallS);
		}
	}
}
for (const [name, xs] of Object.entries(runs)) {
	const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
	console.log(`${name.padEnd(18)} ${(mean * 1000).toFixed(0)} ms pour 180 frames (${xs.map((x) => (x * 1000).toFixed(0)).join(", ")})`);
}
fs.rmSync(`${HERE}/e2e/t.mp4`, { force: true });
