export const KEYCHAIN_SERVICE = "openai-live-api-key";

export class KeyMissingError extends Error {
  constructor() {
    super("OpenAI API key missing; run scripts/set-key.sh");
    this.name = "KeyMissingError";
  }
}

export async function readApiKey(service = KEYCHAIN_SERVICE): Promise<string> {
  if (process.env.OPENAI_API_KEY) {
    console.warn("warn key_source=env");
    return process.env.OPENAI_API_KEY;
  }
  const security = process.env.OLV_SECURITY_BIN ?? "security";
  const args = ["find-generic-password", "-s", service, "-w"];
  const proc = Bun.spawn(security.endsWith(".sh") ? ["/bin/sh", security, ...args] : [security, ...args], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const key = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  if (!key) throw new KeyMissingError();
  return key;
}

export function redact<T>(value: T): T {
  if (typeof value === "string") return (value.startsWith("sk-") ? "sk-***" : value) as T;
  if (Array.isArray(value)) return value.map(redact) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)])) as T;
  }
  return value;
}
