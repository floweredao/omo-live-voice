import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OMO = "/Applications/OmO.app/Contents/Resources/omo-runtime/darwin-arm64/omo";
const DIR = import.meta.dir;
const OUT = join(DIR, "out");
const mode = process.argv.includes("--no-ext") ? "no-ext" : process.argv.includes("--discover") ? "discover" : "happy";
const PHASE_MS = 60_000;

mkdirSync(OUT, { recursive: true });
const logPath = mode === "happy" ? join(OUT, "log.txt") : join(OUT, `log-${mode}.txt`);
const framesPath = join(OUT, `frames-${mode}.jsonl`);
rmSync(logPath, { force: true });
writeFileSync(framesPath, "");

const args = ["--mode", "rpc", "--no-session"];
if (mode === "happy") args.push("--no-extensions", "-e", join(DIR, "index.ts"));
if (mode === "no-ext") args.push("--no-extensions");

type Frame = Record<string, unknown> & { type?: string };
const frames: Frame[] = [];
const waiters = new Set<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void }>();

const child = Bun.spawn([OMO, ...args], {
	cwd: OUT,
	stdin: "pipe",
	stdout: "pipe",
	stderr: Bun.file(join(OUT, `stderr-${mode}.log`)),
	env: { ...process.env, OLV_SPIKE_LOG: logPath },
});
console.log(`[drive] mode=${mode} pid=${child.pid} args=${args.join(" ")}`);

function send(frame: Frame): void {
	child.stdin.write(`${JSON.stringify(frame)}\n`);
	child.stdin.flush();
	console.log(`[drive] >> ${JSON.stringify(frame)}`);
}

function answerDialog(f: Frame): void {
	const method = f.method as string;
	if (method === "select") {
		const options = (f.options as string[]) ?? [];
		send({ type: "extension_ui_response", id: f.id as string, value: options.find((o) => o === "A") ?? options[0] });
	} else if (method === "confirm") {
		send({ type: "extension_ui_response", id: f.id as string, confirmed: true });
	} else if (method === "input" || method === "editor") {
		send({ type: "extension_ui_response", id: f.id as string, value: "A" });
	} else if (method === "question") {
		const qs = (f.questions as { id: string }[]) ?? [];
		send({ type: "extension_ui_response", id: f.id as string, answers: Object.fromEntries(qs.map((q) => [q.id, { selected: ["A"] }])) });
	}
}

function onFrame(f: Frame): void {
	frames.push(f);
	writeFileSync(framesPath, `${JSON.stringify(f)}\n`, { flag: "a" });
	if (f.type === "extension_ui_request") {
		console.log(`[drive] << extension_ui_request ${JSON.stringify(f).slice(0, 300)}`);
		answerDialog(f);
	} else if (f.type === "response" || f.type === "agent_end" || f.type === "tool_execution_start") {
		console.log(`[drive] << ${JSON.stringify(f).slice(0, 300)}`);
	}
	for (const w of waiters) {
		if (w.pred(f)) {
			waiters.delete(w);
			w.resolve(f);
		}
	}
}

(async () => {
	const decoder = new TextDecoder();
	let buf = "";
	for await (const chunk of child.stdout) {
		buf += decoder.decode(chunk, { stream: true });
		let nl = buf.indexOf("\n");
		while (nl >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (line) {
				try {
					onFrame(JSON.parse(line));
				} catch {
					console.log(`[drive] non-json stdout: ${line.slice(0, 200)}`);
				}
			}
			nl = buf.indexOf("\n");
		}
	}
})();

function waitFor(label: string, pred: (f: Frame) => boolean, ms = PHASE_MS): Promise<Frame | null> {
	const seen = frames.find(pred);
	if (seen) return Promise.resolve(seen);
	return new Promise((resolve) => {
		const w = {
			pred,
			resolve: (f: Frame) => {
				clearTimeout(timer);
				resolve(f);
			},
		};
		const timer = setTimeout(() => {
			waiters.delete(w);
			console.log(`[drive] timeout waiting for ${label} after ${ms} ms`);
			resolve(null);
		}, ms);
		waiters.add(w);
		child.exited.then(() => {
			if (waiters.delete(w)) {
				clearTimeout(timer);
				console.log(`[drive] child exited while waiting for ${label}`);
				resolve(null);
			}
		});
	});
}

const since = (n: number) => (pred: (f: Frame) => boolean) => (f: Frame) => frames.indexOf(f) >= n && pred(f);
const isSettled = (f: Frame) => f.type === "agent_settled";
const isFailedResponse = (id: string) => (f: Frame) => f.type === "response" && f.id === id && f.success === false;

let mark = frames.length;
send({ id: "p1", type: "prompt", message: "/ping hello" });
await waitFor("agent_settled after /ping", (f) => since(mark)(isSettled)(f) || isFailedResponse("p1")(f));

if (mode !== "no-ext") {
	mark = frames.length;
	send({ id: "p2", type: "prompt", message: "/ping-abort" });
	await waitFor(
		"abort isIdle notify",
		since(mark)((f) => f.type === "extension_ui_request" && f.method === "notify" && String(f.message).startsWith("abort isIdle=")),
	);
}

if (mode === "discover") {
	mark = frames.length;
	send({ id: "p3", type: "prompt", message: "/ping-ask" });
	await waitFor("agent_settled after /ping-ask", since(mark)(isSettled), 90_000);
}

child.stdin.end();
child.kill("SIGTERM");
const code = await Promise.race([child.exited, new Promise<string>((r) => setTimeout(() => r("still-running"), 5000))]);
if (code === "still-running") child.kill("SIGKILL");
console.log(`[drive] child exit=${await child.exited}`);

let log = "";
try {
	log = readFileSync(logPath, "utf8");
} catch {
	log = "";
}
const lines = log.split("\n");
const has = (re: RegExp) => lines.find((l) => re.test(l)) ?? null;
const uiReq = (method: string, pred: (f: Frame) => boolean) =>
	frames.find((f) => f.type === "extension_ui_request" && f.method === method && pred(f)) ?? null;
const deltaFrame = frames.find(
	(f) => f.type === "message_update" && (f.assistantMessageEvent as { type?: string } | undefined)?.type === "text_delta",
);
const abortedEnd = frames.find((f) => f.type === "agent_end" && (f.aborted === true || JSON.stringify(f).includes('"stopReason":"aborted"')));

const cap = (ok: unknown, evidence: unknown) => ({ pass: Boolean(ok), evidence: ok ? String(typeof evidence === "string" ? evidence : JSON.stringify(evidence)).slice(0, 240) : "missing" });
const caps = {
	command: cap(has(/^PING hello$/), has(/^PING hello$/)),
	sendUserMessage: cap(has(/^input source=extension/), has(/^input source=extension/)),
	message_update: cap(deltaFrame && has(/^delta /), `frame text_delta + log ${has(/^delta /)}`),
	agent_end: cap(has(/^agent_end .*pong/i), has(/^agent_end .*pong/i)),
	notify_setStatus: cap(
		uiReq("notify", (f) => f.message === "ping ok") && uiReq("setStatus", (f) => f.statusKey === "ping"),
		[uiReq("notify", (f) => f.message === "ping ok"), uiReq("setStatus", (f) => f.statusKey === "ping")],
	),
	abort: cap(has(/^abort isIdle=true$/) && abortedEnd, `${has(/^abort isIdle=true$/)}; agent_end aborted=${abortedEnd?.aborted} abortSource=${abortedEnd?.abortSource}`),
	ask_user_events: cap(has(/^ask-user:asked /), has(/^ask-user:asked /)),
};
const required = ["command", "sendUserMessage", "message_update", "agent_end", "abort"] as const;
const ok = required.every((k) => caps[k].pass);
writeFileSync(join(OUT, `result-${mode}.json`), `${JSON.stringify({ mode, caps, frames: frames.length }, null, 2)}\n`);
for (const [k, v] of Object.entries(caps)) console.log(`cap:${k} ${v.pass ? "PASS" : "FAIL"} ${v.evidence}`);
console.log(`[drive] frames=${frames.length} required=${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);
