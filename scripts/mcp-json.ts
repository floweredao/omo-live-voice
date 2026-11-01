// usage: bun scripts/mcp-json.ts add|remove <mcp.json path> [<bun path> <server.ts path>]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const [op, file, bun, server] = process.argv.slice(2);
if ((op !== "add" && op !== "remove") || !file) { console.error("usage: mcp-json.ts add|remove <mcp.json> [bun server.ts]"); process.exit(2); }
const cfg = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
cfg.mcpServers ??= {};
if (op === "add") cfg.mcpServers.omo_live_voice = { command: bun, args: [server], requestTimeoutMs: 30000, startupTimeoutMs: 10000 };
else delete cfg.mcpServers.omo_live_voice;
writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
