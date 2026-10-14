// Temps d'export natif (exportMulti, le chemin de l'app) sans effet, avec l'effet de l'agent (le
// ripple, sur toute la vidéo) et avec un effet lourd, en passes alternées ; la première est jetée.
// Adapté de `spike-tools/shader-fx/export-time.mjs`.
//
//   node export-time.mjs <worktree>
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const WT = path.resolve(process.argv[2]);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const addon = createRequire(import.meta.url)(`${WT}/electron/native/bin/darwin-arm64/compositor_view.node`);

const scene = JSON.parse(fs.readFileSync(`${HERE}/e2e/scene-effect.json`, "utf8"));
const full = { ...scene, shaderEffects: scene.shaderEffects.map((e) => ({ ...e, startSec: 0, endSec: 6 })) };
const plain = { ...scene, shaderEffects: [] };
const heavy = fs.readFileSync(`${HERE}/heavy.wgsl`, "utf8");
const heavyScene = {
	...full,
	shaderEffects: full.shaderEffects.map((e) => ({ ...e, code: heavy, params: [{ name: "strength", type: "number" }], values: { strength: 1 } })),
};
const clips = scene.clips;

const runs = { "sans effet": [], "effet de l'agent": [], "effet lourd": [] };
for (let round = 0; round < 4; round++) {
	for (const [name, s] of [["sans effet", plain], ["effet de l'agent", full], ["effet lourd", heavyScene]]) {
		const stats = await addon.exportMulti(clips, `${HERE}/e2e/t.mp4`, JSON.stringify(s), { width: 1752, height: 1080, fps: 30 });
		if (round > 0) runs[name].push(stats.wallS);
		if (round === 0) console.log(name, JSON.stringify(stats).slice(0, 200));
	}
}
const out = {};
for (const [name, xs] of Object.entries(runs)) {
	const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
	out[name] = Math.round(mean * 1000);
	console.log(`${name.padEnd(18)} ${(mean * 1000).toFixed(0)} ms pour 180 frames (${xs.map((x) => (x * 1000).toFixed(0)).join(", ")})`);
}
fs.writeFileSync(`${HERE}/e2e/export-time.json`, JSON.stringify(out, null, 1));
fs.rmSync(`${HERE}/e2e/t.mp4`, { force: true });
