// Une itération de l'agent contre la CLI `openscreen mcp` du worktree, profil de test séparé.
//
//   node fx-loop.mjs init <video> [title]          projet + checkpoint, état dans loop/state.json
//   node fx-loop.mjs apply <effect.wgsl> <start> <end> [p0,p1,…] [frameTimes,…]
//        → addShaderEffect (1re fois) ou setShaderEffect, puis export + getFrames dans loop/<n>/
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WT = "C:/Users/etien/Documents/repos/openscreen/.claude/worktrees/custom-shader-fx-spike";
const HERE = "C:/Users/etien/AppData/Local/Temp/claude/C--Users-etien-Documents-repos-openscreen/5ab28e90-5aed-42e2-90c1-3a8ecc0eeec1/scratchpad/fx";
const LOOP = path.join(HERE, "loop");
const STATE = path.join(LOOP, "state.json");
fs.mkdirSync(LOOP, { recursive: true });
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { round: 0 };
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));

const child = spawn(
	"C:/Users/etien/Documents/repos/openscreen/.claude/worktrees/node_modules/electron/dist/electron.exe",
	[".", `--user-data-dir=${path.join(process.env.APPDATA, "openscreen-shader-fx-spike")}`, "mcp"],
	{ cwd: WT, stdio: ["pipe", "pipe", "pipe"] },
);
child.stderr.resume();
let buffer = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
	buffer += chunk.toString("utf8");
	for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
		const line = buffer.slice(0, nl).trim();
		buffer = buffer.slice(nl + 1);
		if (!line.startsWith("{")) continue;
		const msg = JSON.parse(line);
		pending.get(msg.id)?.(msg);
		pending.delete(msg.id);
	}
});
let nextId = 1;
function request(method, params) {
	const id = nextId++;
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	return new Promise((resolve) => pending.set(id, resolve));
}
async function call(name, args) {
	const msg = await request("tools/call", { name, arguments: args });
	const content = msg.result?.content ?? [];
	return {
		error: msg.result?.isError || !!msg.error,
		text: content.filter((c) => c.type === "text").map((c) => c.text).join("\n") || JSON.stringify(msg.error),
		images: content.filter((c) => c.type === "image"),
	};
}

const [cmd, ...rest] = process.argv.slice(2);
try {
	await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fx-loop", version: "0" } });
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	if (cmd === "init") {
		const [video, title = "prompt-test"] = rest;
		const created = await call("createProject", { title, videoPath: path.resolve(video) });
		console.log(created.text);
		state.projectId = JSON.parse(created.text).projectId;
		state.effectId = undefined;
		state.round = 0;
		console.log((await call("createCheckpoint", { projectId: state.projectId })).text);
		save();
	} else if (cmd === "apply") {
		const [file, start, end, params = "", times = ""] = rest;
		const code = fs.readFileSync(file, "utf8");
		const args = {
			projectId: state.projectId,
			startSec: Number(start),
			endSec: Number(end),
			code,
			...(params ? { params: params.split(",").map(Number) } : {}),
		};
		// Les checkpoints vivent dans le processus serveur : un par itération.
		await call("createCheckpoint", { projectId: state.projectId });
		const result = state.effectId
			? await call("setShaderEffect", { ...args, shaderEffectId: state.effectId })
			: await call("addShaderEffect", args);
		console.log(`${state.effectId ? "setShaderEffect" : "addShaderEffect"}:`, result.text);
		if (!result.error) {
			state.effectId = JSON.parse(result.text).shaderEffectId;
			state.round += 1;
			save();
			const dir = path.join(LOOP, String(state.round));
			fs.mkdirSync(dir, { recursive: true });
			fs.copyFileSync(file, path.join(dir, "effect.wgsl"));
			const exported = await call("exportVideo", { projectId: state.projectId, path: path.join(dir, "export.mp4"), fps: 30 });
			console.log("exportVideo:", exported.text);
			const atSec = times ? times.split(",").map(Number) : undefined;
			const frames = await call("getFrames", { projectId: state.projectId, ...(atSec ? { atSec } : { count: 8 }) });
			console.log(frames.text);
			frames.images.forEach((img, i) => {
				fs.writeFileSync(path.join(dir, `frame-${i}.jpg`), Buffer.from(img.data, "base64"));
			});
			console.log(`→ ${dir}`);
		}
	} else {
		console.log("usage: init <video> [title] | apply <effect.wgsl> <start> <end> [params] [times]");
	}
} finally {
	child.stdin.end();
	setTimeout(() => child.kill(), 2000);
}
