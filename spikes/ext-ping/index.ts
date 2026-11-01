import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const LOG = process.env.OLV_SPIKE_LOG ?? join(import.meta.dir, "out", "log.txt");
mkdirSync(dirname(LOG), { recursive: true });

function log(line: string): void {
	appendFileSync(LOG, `${line.replace(/\n/g, "\\n")}\n`);
}

function shape(value: unknown, depth = 0): unknown {
	if (value === null || typeof value !== "object") return typeof value;
	if (Array.isArray(value)) return depth > 2 ? "array" : [shape(value[0], depth + 1)];
	if (depth > 2) return "object";
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) out[k] = k === "ctx" ? "ctx" : shape(v, depth + 1);
	return out;
}

function lastAssistantText(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; content?: unknown };
		if (m?.role !== "assistant") continue;
		if (typeof m.content === "string") return m.content;
		if (Array.isArray(m.content)) {
			return m.content
				.filter((c: { type?: string }) => c?.type === "text")
				.map((c: { text?: string }) => c.text ?? "")
				.join("");
		}
	}
	return "";
}

type Loose = any;

export default function (pi: Loose) {
	log(`loaded pid=${process.pid}`);

	pi.registerCommand("ping", {
		description: "olv spike: log, notify, set status, then ask the model for PONG",
		handler: async (args: string, ctx: Loose) => {
			log(`PING ${args ?? ""}`.trimEnd());
			ctx.ui.notify("ping ok", "info");
			ctx.ui.setStatus("ping", "listening");
			pi.sendUserMessage("Reply with exactly the word PONG and nothing else.");
		},
	});

	pi.registerCommand("ping-abort", {
		description: "olv spike: start a long reply, abort it after 2 s, report idleness 1 s later",
		handler: async (_args: string, ctx: Loose) => {
			log("PING-ABORT start");
			pi.sendUserMessage("Count slowly from 1 to 200, one number per line.");
			setTimeout(() => {
				log(`abort call isIdleBefore=${ctx.isIdle()}`);
				ctx.abort();
				setTimeout(() => {
					const idle = ctx.isIdle();
					log(`abort isIdle=${idle}`);
					ctx.ui.notify(`abort isIdle=${idle}`, "info");
				}, 1000);
			}, 2000);
		},
	});

	pi.registerCommand("ping-ask", {
		description: "olv spike: make the model call the built-in question tool",
		handler: async () => {
			log("PING-ASK start");
			pi.sendUserMessage(
				"Call the ask_user_question tool exactly once with one question (header 'Pick', question 'Pick one', options 'A' and 'B', waitForAnswer true). After the answer arrives, reply with only the chosen letter.",
			);
		},
	});

	pi.on("input", async (event: Loose) => {
		log(`input source=${event.source} streamingBehavior=${event.streamingBehavior} text=${String(event.text).slice(0, 60)}`);
		return { action: "continue" };
	});
	pi.on("message_update", async (event: Loose) => {
		const e = event.assistantMessageEvent;
		if (e?.type === "text_delta") log(`delta ${e.delta}`);
	});
	pi.on("agent_end", async (event: Loose) => {
		log(`agent_end ${lastAssistantText(event.messages).slice(0, 200)}`);
	});
	pi.on("tool_execution_start", async (event: Loose) => log(`tool_execution_start ${event.toolName}`));
	pi.on("tool_execution_end", async (event: Loose) => log(`tool_execution_end ${event.toolName} isError=${event.isError}`));
	pi.on("turn_end", async () => log("turn_end"));

	pi.events.on("ask-user:asked", (payload: unknown) => log(`ask-user:asked ${JSON.stringify(shape(payload))}`));
	pi.events.on("ask-user:settled", (payload: unknown) => log(`ask-user:settled ${JSON.stringify(shape(payload))}`));
	pi.events.on("ask-user:closed", (p: Loose) => log(`ask-user:closed status=${p?.status} resolvedBy=${p?.resolvedBy}`));
}
