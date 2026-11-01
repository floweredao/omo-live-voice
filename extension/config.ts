// Build-time decisions copied from .omo/handoff/p0/decisions.json (measured in P0).

export type PanelHost = "browser-tab" | "mcp-app";

/** decisions.panelHost: the OmO MCP App side panel never rendered, so the panel opens in a browser tab. */
export const PANEL_HOST: PanelHost = "browser-tab" as PanelHost;

/** decisions.askUserAnswerApi: an extension can only observe ask-user events, never answer them. */
export const ASK_USER_ANSWER_API = false;

/** How long `/voice stop` waits for the bridge to exit before SIGTERM. */
export const STOP_TIMEOUT_MS = 5000;

/** mcp-app only: fall back to a browser tab if no panel connects within this time. */
export const MCP_APP_FALLBACK_MS = 15000;
