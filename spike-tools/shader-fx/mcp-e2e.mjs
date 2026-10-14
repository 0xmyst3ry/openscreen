// Joue la boucle de l'agent contre la CLI `openscreen mcp` du worktree (stdio, JSON-RPC
// ligne à ligne) : createProject, export sans effet, addShaderEffect cassé puis corrigé,
// export avec effet, getFrames. Tout ce qui sort va dans e2e/.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WT = "C:/Users/etien/Documents/repos/openscreen/.claude/worktrees/custom-shader-fx-spike";
const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, "$1");
const OUT = path.join(HERE, "e2e");
fs.mkdirSync(OUT, { recursive: true });
const VIDEO = path.join(HERE, "media", "demo.mp4");

const child = spawn(path.join(WT, "node_modules/electron/dist/electron.exe"), [".", `--user-data-dir=${path.join(process.env.APPDATA, "openscreen-shader-fx-spike")}`, "mcp"], {
	cwd: WT,
	stdio: ["pipe", "pipe", "pipe"],
});
const stderr = fs.createWriteStream(path.join(OUT, "stderr.log"));
child.stderr.pipe(stderr);

let buffer = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
	buffer += chunk.toString("utf8");
	let nl;
	while ((nl = buffer.indexOf("\n")) >= 0) {
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
	log.push({ name, args: { ...args, code: args.code ? `${args.code.length} chars` : undefined }, ms, isError: msg.result?.isError ?? !!msg.error, texts, error: msg.error, images: images.length });
	console.log(`\n### ${name} (${ms} ms)${msg.result?.isError ? " ERROR" : ""}\n${texts.join("\n").slice(0, 1500)}${msg.error ? JSON.stringify(msg.error) : ""}`);
	return { msg, texts, images, ms };
}

const BROKEN = `// Pulse d'aberration chromatique + vignette qui respire, le temps d'un passage clé.
fn effect(uv: vec2<f32>) -> vec4<f32> {
    let pulse = sin(ctx.progress * 3.14159265);
    let off = (uv - 0.5) * 0.012 * pulse * strenght;
    let col = vec3<f32>(frame(uv + off).r, frame(uv).g, frame(uv - off).b);
    let v = uv - 0.5;
    let vignette = 1.0 - dot(v, v) * 1.6 * pulse;
    return vec4<f32>(col * vignette, 1.0);
}
`;
const FIXED = BROKEN.replace("* strenght;", "* param(0);");

try {
	const init = await request("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "shader-fx-spike", version: "0" },
	});
	console.log("server:", init.result?.serverInfo);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const tools = await request("tools/list", {});
	const names = tools.result.tools.map((t) => t.name);
	console.log("has addShaderEffect:", names.includes("addShaderEffect"), "setShaderEffect:", names.includes("setShaderEffect"));

	const created = await call("createProject", { title: "shader-fx-spike", videoPath: VIDEO });
	const projectId = /"projectId"\s*:\s*"([^"]+)"/.exec(created.texts.join(""))?.[1] ?? /proj[^\s"',]+/.exec(created.texts.join(""))?.[0];
	console.log("projectId:", projectId);

	await call("createCheckpoint", { projectId });
	const plain = await call("exportVideo", { projectId, path: path.join(OUT, "plain.mp4"), fps: 30 });
	const broken = await call("addShaderEffect", { projectId, startSec: 1, endSec: 5, code: BROKEN, params: [1] });
	const fixed = await call("addShaderEffect", { projectId, startSec: 1, endSec: 5, code: FIXED, params: [1] });
	const withFx = await call("exportVideo", { projectId, path: path.join(OUT, "effect.mp4"), fps: 30 });
	const frames = await call("getFrames", { projectId, atSec: [0.5, 2, 3, 4.5] });
	frames.images.forEach((img, i) => {
		const ext = img.mimeType === "image/png" ? "png" : "jpg";
		fs.writeFileSync(path.join(OUT, `frame-${i}.${ext}`), Buffer.from(img.data, "base64"));
	});
	log.push({ summary: { plainExportMs: plain.ms, effectExportMs: withFx.ms, brokenRefused: broken.msg.result?.isError, fixedAccepted: !fixed.msg.result?.isError } });
} catch (error) {
	console.error("FAILED", error);
} finally {
	fs.writeFileSync(path.join(OUT, "log.json"), JSON.stringify(log, null, 2));
	child.stdin.end();
	setTimeout(() => child.kill(), 3000);
}
