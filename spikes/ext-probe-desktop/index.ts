type Loose = any;
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// OLV desktop entry probe: logs load/session_start/input/command/tool to out/log.jsonl.
// Whole body wrapped in try/catch so a load error never breaks a session. Never sends user messages.
const OUT_DIR = join(import.meta.dir, "out");
const LOG = OUT_DIR + "/log.jsonl";

function log(obj: Loose) {
	try {
		mkdirSync(OUT_DIR, { recursive: true });
		appendFileSync(LOG, JSON.stringify({ ...obj, pid: process.pid, ts: new Date().toISOString() }) + "\n");
	} catch {}
}

export default function (pi: Loose) {
	try {
		log({ ev: "load", argv: process.argv.slice(1, 4) });

		pi.on("session_start", async (event: Loose) => {
			try {
				log({ ev: "session_start", reason: event?.reason });
			} catch {}
		});

		pi.on("input", async (event: Loose) => {
			try {
				const text = typeof event?.text === "string" ? event.text : "";
				if (text.includes("olvprobe")) log({ ev: "input", source: event?.source, text });
			} catch {}
		});

		pi.registerCommand("olvprobe", {
			description: "OLV probe",
			handler: async (args: string, ctx: Loose) => {
				try {
					log({ ev: "command", args });
					ctx.ui.notify("olvprobe ok", "info");
				} catch {}
			},
		});

		pi.registerTool({
			name: "olv_probe_tool",
			label: "OLV Probe Tool",
			description: "OLV probe tool: returns the text PROBE_OK. Takes no parameters.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			async execute() {
				log({ ev: "tool" });
				return { content: [{ type: "text", text: "PROBE_OK" }], details: {} };
			},
		});
	} catch {}
}
