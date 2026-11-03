import type { ChatMessage } from "./tx/types.js";

export type ResponseContentPart =
  | { type: "input_text" | "output_text"; text: string; [key: string]: unknown }
  | { type: "refusal"; refusal: string; [key: string]: unknown };

export interface ResponseMessageItem {
  type: "message";
  role: "system" | "developer" | "user" | "assistant";
  content: ResponseContentPart[];
  id?: string;
  status?: string;
  phase?: string | null;
  [key: string]: unknown;
}
export interface ResponseFunctionCallItem {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
  id?: string;
  status?: string;
  [key: string]: unknown;
}
export interface ResponseFunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string;
  [key: string]: unknown;
}
export interface ResponseReasoningItem {
  type: "reasoning";
  id?: string;
  summary?: Array<Record<string, unknown>>;
  content?: Array<Record<string, unknown>>;
  encrypted_content?: string | null;
  [key: string]: unknown;
}
export type ResponseItem = ResponseMessageItem | ResponseFunctionCallItem
  | ResponseFunctionCallOutputItem | ResponseReasoningItem;

export interface ResponseFunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown> | null;
  strict?: boolean | null;
}
export type ResponseToolChoice = "auto" | "none" | "required" | { type: "function"; name: string };
export interface ResponseRequest {
  input: ResponseItem[];
  instructions?: string;
  max_output_tokens?: number;
  tools?: ResponseFunctionTool[];
  tool_choice?: ResponseToolChoice;
  parallel_tool_calls?: boolean;
  reasoning?: { effort?: string; summary?: string };
  text?: Record<string, unknown>;
  temperature?: number;
  top_p?: number;
}

export type ResponseAdapterApi = "responses" | "chat-completions" | "ollama";

export class ResponseCompatibilityError extends Error {
  constructor(
    readonly param: string,
    message: string,
  ) {
    super(message);
    this.name = "ResponseCompatibilityError";
  }
}
export interface ResponseUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: Record<string, unknown>;
  output_tokens_details?: Record<string, unknown>;
  [key: string]: unknown;
}
export interface ResponseObject {
  id: string;
  object: "response";
  created_at: number;
  model: string;
  status: "in_progress" | "completed" | "incomplete" | "failed";
  output: ResponseItem[];
  usage: ResponseUsage | null;
  error: Record<string, unknown> | null;
  incomplete_details: { reason: string } | null;
  [key: string]: unknown;
}
export interface ResponseStreamEvent {
  type: string;
  sequence_number?: number;
  [key: string]: unknown;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}
function optionalString(item: Record<string, unknown>, key: string): void {
  if (item[key] !== undefined && typeof item[key] !== "string") throw new Error(`${key} must be a string`);
}
function knownKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`unsupported ${label} field: ${key}`);
  }
}

/** Preserve native replay fields. Only easy message syntax needs normalization. */
function normalizeItem(raw: unknown): ResponseItem {
  const item = object(raw, "input item");
  const type = item.type ?? (typeof item.role === "string" ? "message" : undefined);
  optionalString(item, "id");
  optionalString(item, "status");
  switch (type) {
    case "message": {
      if (typeof item.role !== "string" || !["system", "developer", "user", "assistant"].includes(item.role)) {
        throw new Error("unsupported message role");
      }
      if (item.tool_calls !== undefined || item.tool_call_id !== undefined) {
        throw new Error("use function_call and function_call_output items");
      }
      if (item.phase !== null) optionalString(item, "phase");
      let content: ResponseContentPart[];
      if (typeof item.content === "string") {
        content = [{ type: item.role === "assistant" ? "output_text" : "input_text", text: item.content }];
      } else if (Array.isArray(item.content)) {
        content = item.content.map((rawPart) => {
          const part = object(rawPart, "message content part");
          if (part.type === "input_text" || part.type === "output_text") {
            if (typeof part.text !== "string") throw new Error("text content must contain a string");
            if (part.annotations !== undefined && !Array.isArray(part.annotations)) {
              throw new Error("annotations must be an array");
            }
          } else if (part.type === "refusal") {
            if (typeof part.refusal !== "string") throw new Error("refusal must contain a string");
          } else {
            throw new Error(`unsupported content type: ${String(part.type)}`);
          }
          return part as ResponseContentPart;
        });
      } else {
        throw new Error("message content must be text or an array of text parts");
      }
      return { ...item, type: "message", role: item.role, content } as ResponseMessageItem;
    }
    case "function_call":
      nonempty(item.call_id, "call_id");
      nonempty(item.name, "function name");
      if (typeof item.arguments !== "string") throw new Error("function arguments must be a string");
      return item as unknown as ResponseFunctionCallItem;
    case "function_call_output":
      nonempty(item.call_id, "call_id");
      if (typeof item.output !== "string") throw new Error("function output must be a string");
      return item as unknown as ResponseFunctionCallOutputItem;
    case "reasoning":
      if (item.encrypted_content !== undefined && item.encrypted_content !== null
        && typeof item.encrypted_content !== "string") throw new Error("encrypted_content must be a string");
      for (const key of ["summary", "content"]) {
        if (item[key] !== undefined) {
          if (!Array.isArray(item[key])) throw new Error(`reasoning ${key} must be an array`);
          for (const part of item[key] as unknown[]) object(part, `reasoning ${key} part`);
        }
      }
      return item as unknown as ResponseReasoningItem;
    default:
      throw new Error(`unsupported input item type: ${String(type)}`);
  }
}

export function normalizeResponseInput(raw: unknown): ResponseItem[] {
  if (typeof raw === "string") return [normalizeItem({ role: "user", content: raw })];
  if (!Array.isArray(raw)) throw new Error("input must be a string or an array of items");
  return raw.map(normalizeItem);
}
export function normalizeResponseOutput(raw: unknown): ResponseItem[] {
  if (!Array.isArray(raw)) throw new Error("response output must be an array");
  return raw.map((value) => {
    const item = normalizeItem(value);
    if (item.type === "function_call_output" || (item.type === "message" && item.role !== "assistant")) {
      throw new Error("response output contains a non-assistant input item");
    }
    return item;
  });
}

/** Validate execution controls; public routing/storage controls belong to the HTTP layer. */
export function normalizeResponseRequest(raw: unknown): ResponseRequest {
  const source = object(raw, "request");
  const request: ResponseRequest = { input: normalizeResponseInput(source.input) };
  if (source.instructions !== undefined && source.instructions !== null) {
    if (typeof source.instructions !== "string") throw new Error("instructions must be a string");
    request.instructions = source.instructions;
  }
  if (source.max_output_tokens !== undefined && source.max_output_tokens !== null) {
    if (typeof source.max_output_tokens !== "number" || !Number.isSafeInteger(source.max_output_tokens) || source.max_output_tokens <= 0) {
      throw new Error("max_output_tokens must be a positive integer");
    }
    request.max_output_tokens = source.max_output_tokens;
  }
  if (source.tools !== undefined) {
    if (!Array.isArray(source.tools)) throw new Error("tools must be an array");
    const names = new Set<string>();
    request.tools = source.tools.map((value) => {
      const tool = object(value, "tool");
      knownKeys(tool, ["type", "name", "description", "parameters", "strict"], "tool");
      if (tool.type !== "function") throw new Error("only function tools are supported");
      const name = nonempty(tool.name, "tool name");
      if (names.has(name)) throw new Error("duplicate function tool name");
      names.add(name);
      optionalString(tool, "description");
      if (tool.parameters !== undefined && tool.parameters !== null) object(tool.parameters, "tool parameters");
      if (tool.strict !== undefined && tool.strict !== null && typeof tool.strict !== "boolean") {
        throw new Error("tool strict must be boolean or null");
      }
      return { ...tool, name } as unknown as ResponseFunctionTool;
    });
  }
  if (source.tool_choice !== undefined) {
    if (typeof source.tool_choice === "string" && ["auto", "none", "required"].includes(source.tool_choice)) {
      request.tool_choice = source.tool_choice as ResponseToolChoice;
    } else {
      const choice = object(source.tool_choice, "tool_choice");
      knownKeys(choice, ["type", "name"], "tool_choice");
      if (choice.type !== "function") throw new Error("unsupported tool_choice");
      request.tool_choice = { type: "function", name: nonempty(choice.name, "tool_choice name") };
    }
    if (typeof request.tool_choice === "object") {
      const name = request.tool_choice.name;
      if (!request.tools?.some(t => t.name === name)) throw new Error("tool_choice names an undefined function");
    }
    if (request.tool_choice === "required" && !request.tools?.length) throw new Error("required tool_choice needs tools");
  }
  if (source.parallel_tool_calls !== undefined) {
    if (typeof source.parallel_tool_calls !== "boolean") throw new Error("parallel_tool_calls must be boolean");
    request.parallel_tool_calls = source.parallel_tool_calls;
  }
  if (source.reasoning !== undefined && source.reasoning !== null) {
    const reasoning = object(source.reasoning, "reasoning");
    knownKeys(reasoning, ["effort", "summary"], "reasoning");
    if (reasoning.effort !== undefined && (typeof reasoning.effort !== "string" || !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(reasoning.effort))) {
      throw new Error("unsupported reasoning effort");
    }
    if (reasoning.summary !== undefined && (typeof reasoning.summary !== "string" || !["auto", "concise", "detailed"].includes(reasoning.summary))) {
      throw new Error("unsupported reasoning summary");
    }
    request.reasoning = { ...reasoning };
  }
  if (source.text !== undefined && source.text !== null) {
    const text = object(source.text, "text");
    knownKeys(text, ["format", "verbosity"], "text");
    if (text.verbosity !== undefined && (typeof text.verbosity !== "string" || !["low", "medium", "high"].includes(text.verbosity))) {
      throw new Error("unsupported text verbosity");
    }
    if (text.format !== undefined) {
      const format = object(text.format, "text.format");
      if (typeof format.type !== "string" || !["text", "json_object", "json_schema"].includes(format.type)) {
        throw new Error("unsupported text format");
      }
      if (format.type === "json_schema") {
        knownKeys(format, ["type", "name", "description", "schema", "strict"], "text.format");
        nonempty(format.name, "schema name");
        optionalString(format, "description");
        object(format.schema, "JSON schema");
        if (format.strict !== undefined && typeof format.strict !== "boolean") {
          throw new Error("schema strict must be boolean");
        }
      } else {
        knownKeys(format, ["type"], "text.format");
      }
    }
    request.text = { ...text };
  }
  for (const key of ["temperature", "top_p"] as const) {
    if (source[key] !== undefined && source[key] !== null) {
      const value = source[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > (key === "temperature" ? 2 : 1)) {
        throw new Error(`${key} is outside its supported range`);
      }
      request[key] = value;
    }
  }
  return request;
}

/**
 * Return the first request field that an upstream adapter cannot preserve.
 * Native Responses supports the complete normalized request.
 */
export function responseCompatibilityError(
  request: ResponseRequest,
  upstreamApi: ResponseAdapterApi,
  reasoningDisabled = false,
): ResponseCompatibilityError | null {
  if (
    reasoningDisabled &&
    request.reasoning?.effort !== undefined &&
    request.reasoning.effort !== "none"
  ) {
    return new ResponseCompatibilityError(
      "reasoning.effort",
      "supplier operator policy disables the requested reasoning effort",
    );
  }
  if (upstreamApi === "responses") return null;

  if (request.reasoning !== undefined) {
    return new ResponseCompatibilityError(
      "reasoning",
      `${upstreamApi} suppliers cannot preserve Responses reasoning options`,
    );
  }
  const reasoningItem = request.input.findIndex((item) => item.type === "reasoning");
  if (reasoningItem !== -1) {
    return new ResponseCompatibilityError(
      `input[${reasoningItem}]`,
      `${upstreamApi} suppliers cannot replay Responses reasoning items`,
    );
  }

  if (upstreamApi === "chat-completions") {
    if (request.text?.verbosity !== undefined) {
      return new ResponseCompatibilityError(
        "text.verbosity",
        "chat-completions suppliers cannot preserve Responses text verbosity",
      );
    }
    return null;
  }

  if (request.text !== undefined) {
    return new ResponseCompatibilityError(
      "text",
      "ollama suppliers cannot preserve Responses text options",
    );
  }
  for (const param of ["tools", "tool_choice", "parallel_tool_calls", "temperature", "top_p"] as const) {
    if (request[param] !== undefined) {
      return new ResponseCompatibilityError(
        param,
        `ollama suppliers cannot preserve Responses ${param}`,
      );
    }
  }
  const functionItem = request.input.findIndex(
    (item) => item.type === "function_call" || item.type === "function_call_output",
  );
  if (functionItem !== -1) {
    return new ResponseCompatibilityError(
      `input[${functionItem}]`,
      "ollama suppliers cannot replay Responses function call items",
    );
  }
  return null;
}

/**
 * Convert the Responses text-format envelope to the Chat Completions
 * response_format envelope without changing the schema.
 */
export function responseTextToChatResponseFormat(
  text: ResponseRequest["text"],
): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  const format = text.format;
  if (format === undefined) return undefined;
  if (format === null || typeof format !== "object" || Array.isArray(format)) {
    throw new ResponseCompatibilityError("text.format", "text.format must be an object");
  }
  const value = format as Record<string, unknown>;
  if (value.type === "text") return undefined;
  if (value.type === "json_object") return { type: "json_object" };
  if (value.type !== "json_schema") {
    throw new ResponseCompatibilityError("text.format.type", "unsupported text format");
  }
  return {
    type: "json_schema",
    json_schema: {
      name: value.name,
      ...(value.description === undefined ? {} : { description: value.description }),
      schema: value.schema,
      ...(value.strict === undefined ? {} : { strict: value.strict }),
    },
  };
}

export function responseOutputText(output: readonly ResponseItem[]): string {
  let text = "";
  for (const item of output) {
    if (item.type !== "message" || item.role !== "assistant") continue;
    for (const part of item.content) if (part.type !== "refusal") text += part.text;
  }
  return text;
}

const EXECUTION_FIELDS = ["input", "instructions", "max_output_tokens", "tools", "tool_choice",
  "parallel_tool_calls", "reasoning", "text", "temperature", "top_p"] as const;
export function responseRequestCommitment(request: ResponseRequest): Record<string, unknown> {
  const envelope: Record<string, unknown> = {};
  for (const key of EXECUTION_FIELDS) if (request[key] !== undefined) envelope[key] = request[key];
  return envelope;
}
export function responseResultCommitment(response: ResponseObject): {
  output: ResponseItem[]; status: ResponseObject["status"]; incomplete_details: { reason: string } | null;
} {
  return { output: response.output, status: response.status, incomplete_details: response.incomplete_details };
}

/** Conversion is confined to explicitly selected non-Responses upstream adapters. */
export function chatMessagesToResponseInput(messages: readonly ChatMessage[]): ResponseItem[] {
  const items: ResponseItem[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      items.push({ type: "function_call_output", call_id: nonempty(message.tool_call_id, "tool_call_id"), output: message.content });
      continue;
    }
    if (message.content !== "" || !message.tool_calls?.length) items.push(normalizeItem({ role: message.role, content: message.content }));
    for (const call of message.tool_calls ?? []) {
      items.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
  }
  return items;
}
export function responseInputToChatMessages(input: readonly ResponseItem[], instructions?: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (instructions !== undefined) messages.push({ role: "system", content: instructions });
  for (const item of input) {
    switch (item.type) {
      case "reasoning":
        throw new Error("this upstream cannot replay Responses reasoning items");
      case "function_call_output":
        messages.push({ role: "tool", content: item.output, tool_call_id: item.call_id });
        break;
      case "function_call": {
        let assistant = messages[messages.length - 1];
        if (!assistant || assistant.role !== "assistant") {
          assistant = { role: "assistant", content: "" };
          messages.push(assistant);
        }
        (assistant.tool_calls ??= []).push({ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } });
        break;
      }
      case "message": {
        const content = item.content.map(part => part.type === "refusal" ? part.refusal : part.text).join("");
        const previous = messages[messages.length - 1];
        if (item.role === "assistant" && previous?.role === "assistant") {
          previous.content += content;
        } else {
          messages.push({ role: item.role === "developer" ? "system" : item.role, content });
        }
        break;
      }
    }
  }
  return messages;
}
export function validateResponseToolOutputs(input: readonly ResponseItem[]): void {
  const calls = new Set<string>();
  const pending = new Set<string>();
  for (const item of input) {
    if (item.type === "function_call") {
      if (calls.has(item.call_id)) throw new Error("duplicate function call_id");
      calls.add(item.call_id);
      pending.add(item.call_id);
    } else if (item.type === "function_call_output") {
      if (!pending.delete(item.call_id)) throw new Error("function output has no pending call_id");
    }
  }
}
const encoder = new TextEncoder();
export function responseInputTokenUpperBound(request: ResponseRequest): number {
  const contextParts = request.input.length + (request.instructions === undefined ? 0 : 1) + (request.tools?.length ?? 0);
  // Cost follows transmitted UTF-8, not the NFC-normalized receipt commitment.
  return 3 + 8 * contextParts + encoder.encode(JSON.stringify(responseRequestCommitment(request))).byteLength;
}

export function createResponse(params: {
  id: string; model: string; output?: ResponseItem[]; usage?: ResponseUsage | null;
  status?: ResponseObject["status"]; created_at?: number;
  incomplete_details?: { reason: string } | null; error?: Record<string, unknown> | null;
}): ResponseObject {
  return {
    id: params.id, object: "response", created_at: params.created_at ?? Math.floor(Date.now() / 1000),
    model: params.model, status: params.status ?? "completed", output: params.output ?? [],
    usage: params.usage ?? null, error: params.error ?? null, incomplete_details: params.incomplete_details ?? null,
  };
}

/** Canonical lifecycle for a completed buffered result; native streams emit the same events incrementally. */
export function responseEvents(response: ResponseObject): ResponseStreamEvent[] {
  const events: ResponseStreamEvent[] = [];
  const emit = (type: string, fields: Record<string, unknown>): void => {
    events.push({ type, sequence_number: events.length, ...fields });
  };
  const initial = { ...response, status: "in_progress", output: [], usage: null, error: null, incomplete_details: null };
  emit("response.created", { response: initial });
  emit("response.in_progress", { response: initial });
  for (let output_index = 0; output_index < response.output.length; output_index++) {
    const item = response.output[output_index];
    const item_id = item.id;
    const start = item.type === "message" ? { ...item, status: "in_progress", content: [] }
      : item.type === "function_call" ? { ...item, status: "in_progress", arguments: "" }
        : { ...item };
    emit("response.output_item.added", { output_index, item: start });
    if (item.type === "message") {
      for (let content_index = 0; content_index < item.content.length; content_index++) {
        const part = item.content[content_index];
        const indices = { item_id, output_index, content_index };
        const refusal = part.type === "refusal";
        emit("response.content_part.added", { ...indices, part: refusal ? { ...part, refusal: "" } : { ...part, text: "" } });
        const text = refusal ? part.refusal : part.text;
        const type = refusal ? "response.refusal" : "response.output_text";
        if (text !== "") emit(`${type}.delta`, { ...indices, delta: text });
        emit(`${type}.done`, { ...indices, [refusal ? "refusal" : "text"]: text });
        emit("response.content_part.done", { ...indices, part });
      }
    } else if (item.type === "function_call") {
      const indices = { item_id, output_index };
      if (item.arguments !== "") emit("response.function_call_arguments.delta", { ...indices, delta: item.arguments });
      emit("response.function_call_arguments.done", { ...indices, arguments: item.arguments, name: item.name });
    }
    emit("response.output_item.done", { output_index, item });
  }
  const terminal = response.status === "incomplete" ? "response.incomplete"
    : response.status === "failed" ? "response.failed" : "response.completed";
  emit(terminal, { response });
  return events;
}

/** Parse SSE framing only. The consumer checks terminal status and output authority. */
export async function* readResponseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ResponseStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let eventName = "";
  let sawTerminal = false;
  let sawDone = false;
  function dispatch(): ResponseStreamEvent | null {
    if (data.length === 0) { eventName = ""; return null; }
    const payload = data.join("\n");
    const name = eventName;
    data = [];
    eventName = "";
    if (sawDone) throw new Error("stream contains data after [DONE]");
    if (payload.trim() === "[DONE]") {
      if (!sawTerminal) throw new Error("stream ended before a terminal response");
      sawDone = true;
      return null;
    }
    if (sawTerminal) throw new Error("stream contains data after a terminal response");
    const parsed = object(JSON.parse(payload), "stream event");
    nonempty(parsed.type, "stream event type");
    if (name !== "" && name !== parsed.type) throw new Error("SSE event name does not match its type");
    if (parsed.type === "response.completed" || parsed.type === "response.incomplete" || parsed.type === "response.failed") {
      sawTerminal = true;
    }
    return parsed as unknown as ResponseStreamEvent;
  }
  function line(value: string): ResponseStreamEvent | null {
    if (value === "") return dispatch();
    if (value.startsWith(":")) return null;
    const colon = value.indexOf(":");
    const field = colon < 0 ? value : value.slice(0, colon);
    let valuePart = colon < 0 ? "" : value.slice(colon + 1);
    if (valuePart.startsWith(" ")) valuePart = valuePart.slice(1);
    if (field === "data") data.push(valuePart);
    else if (field === "event") eventName = valuePart;
    return null;
  }
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const parsed = line(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
        if (parsed) yield parsed;
      }
      if (done) {
        if (buffer !== "") {
          const parsed = line(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
          if (parsed) yield parsed;
        }
        const final = dispatch();
        if (final) yield final;
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
