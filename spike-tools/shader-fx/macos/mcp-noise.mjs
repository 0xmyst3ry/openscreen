// La boucle de l'agent contre la CLI `openscreen mcp` du worktree d'essai (stdio, JSON-RPC ligne à
// ligne), profil de test séparé : createProject, export sans effet, addEffect cassé (refusé) puis
// corrigé (le ripple de la spec, C.6), export avec effet, getFrames. Tout ce qui sort va dans e2e/.
// Adapté de `spike-tools/shader-fx/mcp-e2e.mjs` (Windows, outils du spike) aux outils de la PR 2.
//
//   node mcp-e2e.mjs <worktree>
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WT = path.resolve(process.argv[2]);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(HERE, "e2e");
fs.mkdirSync(OUT, { recursive: true });
const VIDEO = path.join(HERE, "media", "clicks.mp4");
const PROFILE = path.join(HERE, "profile");
const TMP = path.join(HERE, "tmp");
fs.mkdirSync(TMP, { recursive: true });

const child = spawn(
	path.join(WT, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
	[".", `--user-data-dir=${PROFILE}`, "mcp"],
	{
		cwd: WT,
		stdio: ["pipe", "pipe", "pipe"],
		// Son propre TMPDIR : le verrou d'instance unique y vit, et l'app de l'utilisateur ne doit
		// pas le partager. La scène de chaque export est écrite à côté (patch d'essai, jamais poussé).
		env: { ...process.env, TMPDIR: TMP, OPENSCREEN_DUMP_SCENE: path.join(OUT, "scene.json") },
	},
);
child.stderr.pipe(fs.createWriteStream(path.join(OUT, "stderr.log")));

let buffer = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
	buffer += chunk.toString("utf8");
	for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
		const line = buffer.slice(0, nl).trim();
		buffer = buffer.slice(nl + 1);
		if (!line.startsWith("{")) continue;
		const msg = JSON.parse(line);
		if (msg.id !== undefined && pending.has(msg.id)) {
			pending.get(msg.id)(msg);
			pending.delete(msg.id);
		}
	}
});

let nextId = 1;
function request(method, params) {
	const id = nextId++;
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 300_000);
		pending.set(id, (msg) => {
			clearTimeout(timer);
			resolve(msg);
		});
	});
}

const log = [];
async function call(name, args) {
	const t0 = performance.now();
	const msg = await request("tools/call", { name, arguments: args });
	const ms = Math.round(performance.now() - t0);
	const content = msg.result?.content ?? [];
	const texts = content.filter((c) => c.type === "text").map((c) => c.text);
	const images = content.filter((c) => c.type === "image");
	const isError = msg.result?.isError ?? !!msg.error;
	log.push({ name, ms, isError, texts, error: msg.error, images: images.length });
	console.log(`\n### ${name} (${ms} ms)${isError ? " ERROR" : ""}\n${texts.join("\n").slice(0, 1500)}${msg.error ? JSON.stringify(msg.error) : ""}`);
	return { msg, texts, images, ms, isError };
}

const RIPPLE = fs
	.readFileSync(path.join(WT, "docs/shader-effects.md"), "utf8")
	.split("```wgsl\n")[2]
	.split("```")[0];
const BROKEN = RIPPLE.replace("* params.strength;", "* params.strenght;");
if (BROKEN === RIPPLE) throw new Error("the typo did not apply");
const PARAMS = [
	{ type: "number", name: "strength", label: "Force", default: 1, min: 0, max: 2 },
	{ type: "number", name: "radius", label: "Rayon", default: 0.2, min: 0.05, max: 0.5 },
	{ type: "number", name: "duration", label: "Durée", default: 0.9, min: 0.3, max: 2 },
];
const effect = (code) => ({ name: "Ripple au clic", description: "Une onde part de chaque clic et réfracte l'image.", code, params: PARAMS });
const exportOnce = async (name) => {
	const result = await call("exportVideo", { projectId, path: path.join(OUT, `${name}.mp4`), fps: 30 });
	if (fs.existsSync(path.join(OUT, "scene.json"))) fs.renameSync(path.join(OUT, "scene.json"), path.join(OUT, `scene-${name}.json`));
	return result;
};

let projectId;
try {
	await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "shader-fx-macos", version: "0" } });
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	// Le plancher du codec : le même projet sans effet, exporté deux fois.
	const created = await call("createProject", { title: "shader-fx-macos-noise", videoPath: VIDEO });
	projectId = JSON.parse(created.texts.join("")).projectId;
	await exportOnce("plain-a");
	await exportOnce("plain-b");
} catch (error) {
	console.error("FAILED", error);
} finally {
	fs.writeFileSync(path.join(OUT, "log-noise.json"), JSON.stringify(log, null, 2));
	child.stdin.end();
	setTimeout(() => child.kill(), 3000);
}
