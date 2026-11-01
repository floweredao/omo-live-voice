// Pure adapter: agent events -> voice commands, spoken trimmer, utterance router.
// No I/O, no timers, no model calls. `cap` (code points) is passed into every function.
import type { AgentMsg, AgentStatus, ExtToBridge } from "../shared/protocol";

export const CODE_NOTICE = " 코드는 화면에 있어요.";
export const MORE_NOTICE = " 자세한 내용은 화면에 있어요.";
export const FALLBACK_SPOKEN = "답변이 화면에 있어요.";
export const QUESTION_PROMPT = "번호나 이름으로 답해 주세요.";
export const INSTRUCTIONS_PREFIX = "다음 문장을 바꾸지 말고 그대로 전부 말해: ";

const len = (s: string): number => [...s].length;

// ---------------------------------------------------------------- trimmer

interface Cleaned {
  prose: string;
  removedCode: boolean;
  removedTable: boolean;
}

/** Line-by-line markdown cleanup (no regex over the raw document). */
function cleanMarkdown(text: string): Cleaned {
  let removedCode = false;
  let removedTable = false;
  let inFence = false;
  let prevBlank = true;
  let prevCode = false;
  const lines: string[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (t.startsWith("```") || t.startsWith("~~~")) {
      inFence = !inFence;
      removedCode = true;
      prevCode = true;
      prevBlank = false;
      continue;
    }
    if (inFence) {
      removedCode = true;
      continue;
    }
    if (t === "") {
      lines.push("");
      prevBlank = true;
      prevCode = false;
      continue;
    }
    if ((raw.startsWith("    ") || raw.startsWith("\t")) && (prevBlank || prevCode)) {
      removedCode = true;
      prevCode = true;
      prevBlank = false;
      continue;
    }
    prevBlank = false;
    prevCode = false;
    if (t.startsWith("|")) {
      removedTable = true;
      continue;
    }

    let line = t;
    line = line.replace(/`[^`\n]*`/g, () => {
      removedCode = true;
      return "";
    });
    line = line.replace(/`/g, "");
    line = line.replace(/\[([^\]\n]*)\]\(https?:\/\/[^)\s]*\)/g, "$1");
    line = line.replace(/https?:\/\/\S+/g, "");

    let structural = false;
    for (;;) {
      const m = /^(#{1,6}\s+|>+\s*|[-*+•]\s+|\d+[.)]\s+)/.exec(line);
      if (!m) break;
      line = line.slice(m[0].length);
      structural = true;
    }
    // Paired emphasis only, so a lone `*` (e.g. "2 * 3") survives.
    line = line.replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2");
    line = line.replace(/(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g, "$1");
    line = line.replace(/(?<!\w)_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/g, "$1");
    line = line.replace(/\(\s*\)/g, "");
    line = line
      .split(/\s+/)
      .filter((tok) => !(tok.includes("/") && len(tok) > 20))
      .join(" ")
      .trim();
    if (line === "") continue;
    if (structural && !/[.!?。…:]$/.test(line)) line += ".";
    lines.push(line);
  }

  const prose = lines.join(" ").replace(/\s+/g, " ").trim();
  return { prose, removedCode, removedTable };
}

function splitSentences(s: string): string[] {
  const cps = [...s];
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i]!;
    cur += c;
    if (".!?。".includes(c) && (c === "。" || i + 1 === cps.length || /\s/.test(cps[i + 1]!))) {
      const t = cur.trim();
      if (t) out.push(t);
      cur = "";
    }
  }
  const t = cur.trim();
  if (t) out.push(t);
  return out;
}

/** Split into [head, tail]; head is at most `limit` code points, cut at the last space (hard cut when none). */
function cutAtSpace(s: string, limit: number): [string, string] {
  const cps = [...s];
  if (cps.length <= limit) return [s, ""];
  let idx = -1;
  for (let i = Math.min(limit, cps.length - 1); i > 0; i--) {
    if (cps[i] === " ") {
      idx = i;
      break;
    }
  }
  if (idx <= 0) idx = limit;
  return [cps.slice(0, idx).join("").trimEnd(), cps.slice(idx).join("").trimStart()];
}

function hardCut(s: string, budget: number): string {
  const [head] = cutAtSpace(s, Math.max(1, budget - 1));
  return head + "…";
}

function pick(sentences: string[], budget: number): { text: string; shortened: boolean } {
  const first = sentences[0]!;
  if (len(first) > budget) return { text: hardCut(first, budget), shortened: true };
  let text = first;
  let used = 1;
  const second = sentences[1];
  if (second !== undefined && len(`${first} ${second}`) <= budget) {
    text = `${first} ${second}`;
    used = 2;
  }
  return { text, shortened: used < sentences.length };
}

export function toSpoken(text: string, cap: number): { spoken: string; removedCode: boolean; shortened: boolean } {
  const { prose, removedCode, removedTable } = cleanMarkdown(text);
  const sentences = splitSentences(prose);
  if (sentences.length === 0) return { spoken: FALLBACK_SPOKEN, removedCode, shortened: false };

  const first = pick(sentences, cap);
  const shortened = first.shortened || removedTable;
  if (!shortened && !removedCode) return { spoken: first.text, removedCode, shortened };

  const notice = removedCode ? CODE_NOTICE : MORE_NOTICE;
  const second = pick(sentences, Math.max(1, cap - len(notice)));
  return { spoken: second.text + notice, removedCode, shortened: second.shortened || removedTable };
}

// ---------------------------------------------------------------- questions

export interface SpokenQuestion {
  header: string;
  question: string;
  options: { label: string; description?: string }[];
}

/** Pack text into chunks of at most `cap` code points: sentence boundaries first, then last space. */
function packText(text: string, cap: number): string[] {
  const chunks: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur) chunks.push(cur);
    cur = "";
  };
  for (const sentence of splitSentences(text)) {
    let rest = sentence;
    if (cur && len(`${cur} ${rest}`) <= cap) {
      cur = `${cur} ${rest}`;
      continue;
    }
    flush();
    while (len(rest) > cap) {
      const [head, tail] = cutAtSpace(rest, cap);
      chunks.push(head);
      rest = tail;
    }
    cur = rest;
  }
  flush();
  return chunks;
}

export function questionToSpeech(q: SpokenQuestion, cap: number): string[] {
  const head = q.header.trim() ? `질문이에요. ${q.header.trim()}. ${q.question.trim()}` : `질문이에요. ${q.question.trim()}`;
  const items = q.options.map((o, i) => `${i + 1}번 ${o.label.trim()}${i === q.options.length - 1 ? "." : ","}`);
  const optionsPart = items.length > 0 ? `선택지는 ${items.join(" ")} ` : "";
  const whole = `${head} ${optionsPart}${QUESTION_PROMPT}`;
  if (len(whole) <= cap) return [whole];

  const chunks = packText(head, cap);
  let cur = "";
  const flush = () => {
    if (cur) chunks.push(cur);
    cur = "";
  };
  const add = (piece: string) => {
    for (;;) {
      const cand = cur ? `${cur} ${piece}` : piece;
      if (len(cand) <= cap) {
        cur = cand;
        return;
      }
      if (cur) {
        flush();
        continue;
      }
      // Piece alone exceeds cap: split at the last space and continue with a marker.
      const [h, t] = cutAtSpace(piece, cap);
      chunks.push(h);
      piece = `(이어서) ${t}`;
    }
  };
  if (items.length > 0) {
    cur = "선택지는";
    for (const item of items) {
      // keep the leading "선택지는" attached to the first option
      if (cur === "선택지는") {
        const cand = `${cur} ${item}`;
        if (len(cand) <= cap) {
          cur = cand;
          continue;
        }
        // first option too long to share a chunk with the prefix
        const [h, t] = cutAtSpace(cand, cap);
        chunks.push(h);
        cur = "";
        if (t) add(`(이어서) ${t}`);
        continue;
      }
      add(item);
    }
  }
  add(QUESTION_PROMPT);
  flush();
  return chunks;
}

// ---------------------------------------------------------------- utterances

export type Utterance =
  | { kind: "cancel" }
  | { kind: "answer"; requestId: string; optionIndex: number }
  | { kind: "message"; text: string };

const CANCEL_RE = /^(그만|그만해|그만해요|취소|취소해|취소해요|멈춰|멈춰줘|멈춰요|스톱|stop)$/i;

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, " ").replace(/[.!?。]+$/, "").trim();
}

const SINO: Record<string, number> = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 };
const NATIVE: Record<string, number> = { 하나: 1, 둘: 2, 셋: 3, 넷: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9 };
const ORDINAL: Record<string, number> = {
  첫: 1,
  첨: 1,
  두: 2,
  세: 3,
  네: 4,
  다섯: 5,
  여섯: 6,
  일곱: 7,
  여덟: 8,
  아홉: 9,
};

/** 1..9 when the whole utterance is a number reference, else null. */
function parseNumber(n: string): number | null {
  let m = /^([1-9])(?:번째|번)?(?:이요|요)?$/.exec(n);
  if (m) return Number(m[1]);
  m = /^(일|이|삼|사|오|육|칠|팔|구)(?:번째|번)(?:이요|요)?$/.exec(n);
  if (m) return SINO[m[1]!]!;
  m = /^(하나|둘|셋|넷|다섯|여섯|일곱|여덟|아홉)(?:번째|번)?(?:이요|요)?$/.exec(n);
  if (m) return NATIVE[m[1]!]!;
  m = /^(첫|첨|두|세|네|다섯|여섯|일곱|여덟|아홉)(?:번째|번)(?:이요|요)?$/.exec(n);
  if (m) return ORDINAL[m[1]!]!;
  return null;
}

export function classifyUtterance(
  text: string,
  ctx: { pendingQuestion: { requestId: string; options: string[] } | null },
): Utterance {
  const n = normalize(text);
  if (CANCEL_RE.test(n)) return { kind: "cancel" };
  const pq = ctx.pendingQuestion;
  if (pq && n) {
    const hits = new Set<number>();
    const num = parseNumber(n);
    if (num !== null && num <= pq.options.length) hits.add(num - 1);
    const lower = n.toLowerCase();
    pq.options.forEach((label, i) => {
      if (normalize(label).toLowerCase() === lower) hits.add(i);
    });
    // duplicate labels would be ambiguous even if they map to the same text
    const labelMatches = pq.options.filter((l) => normalize(l).toLowerCase() === lower).length;
    if (hits.size === 1 && labelMatches <= 1) {
      return { kind: "answer", requestId: pq.requestId, optionIndex: [...hits][0]! };
    }
  }
  return { kind: "message", text: text.trim() };
}

// ---------------------------------------------------------------- reducer

export type PanelAgentMsg = Omit<AgentMsg, "v" | "seq">;

export type LiveCommand =
  | { kind: "thinking" | "commentary" | "instructions"; content: string; delegationId: string | null }
  | { kind: "panel"; msg: PanelAgentMsg };

export interface AdapterState {
  /** Current session.delegation id; null when none is active (passed through to commands unchanged). */
  delegationId: string | null;
  agent: AgentStatus;
  pendingQuestion: { requestId: string; options: string[] } | null;
}

export function initialAdapterState(delegationId: string | null = null): AdapterState {
  return { delegationId, agent: "idle", pendingQuestion: null };
}

function assertWithinCap(commands: LiveCommand[], cap: number): void {
  for (const c of commands) {
    if (c.kind !== "panel" && len(c.content) > cap) {
      throw new Error(`voice command ${c.kind} is ${len(c.content)} code points, over cap ${cap}`);
    }
  }
}

export function reduceAgent(event: ExtToBridge, state: AdapterState, cap: number): { state: AdapterState; commands: LiveCommand[] } {
  let next = state;
  const commands: LiveCommand[] = [];
  switch (event.type) {
    case "agent.tool.start":
      next = { ...state, agent: "working" };
      commands.push({ kind: "panel", msg: { type: "agent", status: "working", tool: event.name } });
      break;
    case "agent.end":
      commands.push({ kind: "commentary", content: toSpoken(event.text, cap).spoken, delegationId: state.delegationId });
      break;
    case "agent.question": {
      next = {
        ...state,
        agent: "question",
        pendingQuestion: { requestId: event.requestId, options: event.options.map((o) => o.label) },
      };
      commands.push({
        kind: "panel",
        msg: {
          type: "agent",
          status: "question",
          question: { header: event.header, question: event.question, options: event.options.map((o) => o.label) },
        },
      });
      const chunks = questionToSpeech(event, cap - len(INSTRUCTIONS_PREFIX));
      for (const chunk of chunks) {
        commands.push({ kind: "instructions", content: INSTRUCTIONS_PREFIX + chunk, delegationId: state.delegationId });
      }
      break;
    }
    case "agent.question.closed": {
      const pending = state.pendingQuestion?.requestId === event.requestId ? null : state.pendingQuestion;
      next = { ...state, agent: "working", pendingQuestion: pending };
      commands.push({ kind: "panel", msg: { type: "agent", status: "working" } });
      break;
    }
    case "agent.idle": {
      const status: AgentStatus = event.idle ? "idle" : "working";
      next = { ...state, agent: status };
      commands.push({ kind: "panel", msg: { type: "agent", status } });
      break;
    }
    default:
      break; // agent.turn.end, agent.delta, agent.tool.end, hello, confirm, resume, stop: no command
  }
  assertWithinCap(commands, cap);
  return { state: next, commands };
}
