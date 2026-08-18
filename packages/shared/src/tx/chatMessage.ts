/**
 * tx/chatMessage.ts — canonical ChatMessage normalization + equivalence.
 *
 * The supplier's session transcript and the gateway's in-memory mirror must be
 * hash-identical (receipt response_hash = sha256(canonicalize(transcript))),
 * so both sides build messages through normalizeChatMessage: optional fields
 * are truly absent when empty, content is never null, and vendor extras are
 * stripped. chatMessagesEquivalent is the tolerant comparison used by the
 * demo-endpoint transcript-prefix affinity matcher.
 */

import type { ChatMessage, ToolCall } from "./types.js";

const ROLES = new Set(["system", "user", "assistant", "tool"]);

function normalizeToolCall(raw: unknown): ToolCall | null {
  if (typeof raw !== "object" || raw === null) return null;
  const tc = raw as Record<string, unknown>;
  const fn = tc.function as Record<string, unknown> | undefined;
  if (typeof tc.id !== "string" || tc.id === "") return null;
  if (tc.type !== "function") return null;
  if (typeof fn !== "object" || fn === null) return null;
  if (typeof fn.name !== "string" || fn.name === "") return null;
  if (typeof fn.arguments !== "string") return null;
  return { id: tc.id, type: "function", function: { name: fn.name, arguments: fn.arguments } };
}

/**
 * Validate and canonicalize an untrusted message-shaped value.
 * Returns null when the value is not a usable ChatMessage.
 */
export function normalizeChatMessage(raw: unknown): ChatMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.role !== "string" || !ROLES.has(m.role)) return null;
  const role = m.role as ChatMessage["role"];

  let content: string;
  if (typeof m.content === "string") content = m.content;
  else if (m.content === null || m.content === undefined) content = "";
  else return null;

  const msg: ChatMessage = { role, content };

  if (m.tool_calls !== undefined && m.tool_calls !== null) {
    if (role !== "assistant" || !Array.isArray(m.tool_calls)) return null;
    const calls: ToolCall[] = [];
    for (const raw of m.tool_calls) {
      const tc = normalizeToolCall(raw);
      if (!tc) return null;
      calls.push(tc);
    }
    if (calls.length > 0) msg.tool_calls = calls;
  }

  if (m.tool_call_id !== undefined && m.tool_call_id !== null) {
    if (role !== "tool" || typeof m.tool_call_id !== "string" || m.tool_call_id === "") return null;
    msg.tool_call_id = m.tool_call_id;
  }
  if (role === "tool" && msg.tool_call_id === undefined) return null;

  return msg;
}

export function toolCallsEqual(a?: ToolCall[], b?: ToolCall[]): boolean {
  const la = a ?? [];
  const lb = b ?? [];
  if (la.length !== lb.length) return false;
  return la.every((tc, i) =>
    tc.id === lb[i].id &&
    tc.function.name === lb[i].function.name &&
    tc.function.arguments === lb[i].function.arguments,
  );
}

/**
 * Tolerant equality for affinity prefix matching. Both sides are expected to
 * already be normalized; comparison ignores incidental key order and treats
 * missing tool fields as empty.
 */
export function chatMessagesEquivalent(a: ChatMessage, b: ChatMessage): boolean {
  return (
    a.role === b.role &&
    a.content === b.content &&
    (a.tool_call_id ?? "") === (b.tool_call_id ?? "") &&
    toolCallsEqual(a.tool_calls, b.tool_calls)
  );
}
