// Sur les pixels où l'effet agit, l'écart entre l'effet de la preview et celui de l'export, contre
// le plancher du codec : le même projet sans effet exporté deux fois (VideoToolbox n'est pas
// reproductible d'un encodage à l'autre).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const E2E = path.join(HERE, "e2e");
const readPpm = (f) => {
	const b = fs.readFileSync(path.join(E2E, f));
	let pos = 0;
	const fields = [];
	while (fields.length < 4) {
		const m = /^\s*(\S+)/.exec(b.subarray(pos, pos + 32).toString("latin1"));
		fields.push(m[1]);
		pos += m[0].length;
	}
	return b.subarray(pos + 1);
};
const frame = (file, t) =>
	execFileSync(process.env.FFMPEG ?? "ffmpeg", ["-v", "error", "-ss", String(t), "-i", path.join(E2E, file), "-frames:v", "1", "-vf", "scale=in_color_matrix=bt709:in_range=tv", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 64 << 20 });
const out = {};
for (const t of [1.3, 2.9, 4.5]) {
	const [p, pp, e, ep] = [`preview-${t}s.ppm`, `preview-plain-${t}s.ppm`, `export-${t}s.ppm`, `export-plain-${t}s.ppm`].map(readPpm);
	const [a, b] = [frame("plain-a.mp4", t), frame("plain-b.mp4", t)];
	let n = 0, mismatch = 0, floor = 0, magnitude = 0, direct = 0, directPlain = 0;
	for (let i = 0; i < p.length; i += 3) {
		let de = 0, dp = 0;
		for (let c = 0; c < 3; c++) {
			de += Math.abs(e[i + c] - ep[i + c]);
			dp += Math.abs(p[i + c] - pp[i + c]);
		}
		if (de <= 24 && dp <= 24) continue;
		n++;
		for (let c = 0; c < 3; c++) {
			magnitude += Math.abs(p[i + c] - pp[i + c]);
			mismatch += Math.abs(p[i + c] - pp[i + c] - (e[i + c] - ep[i + c]));
			floor += Math.abs(a[i + c] - b[i + c]);
			direct += Math.abs(p[i + c] - e[i + c]);
			directPlain += Math.abs(pp[i + c] - ep[i + c]);
		}
	}
	const f = (x) => +(x / (n * 3)).toFixed(2);
	out[t] = { pixels: n, "effet (preview)": f(magnitude), "écart preview/export de l'effet": f(mismatch), "plancher : deux exports sans effet": f(floor), "preview vs export, avec effet": f(direct), "preview vs export, sans effet (mêmes pixels)": f(directPlain) };
}
console.log(out);
fs.writeFileSync(path.join(E2E, "noise-floor.json"), JSON.stringify(out, null, 1));
