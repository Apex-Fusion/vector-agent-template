import {
  createResponse,
  normalizeResponseOutput,
  readResponseEvents,
  responseEvents,
  responseInputToChatMessages,
  responseCompatibilityError,
  responseTextToChatResponseFormat,
  responseOutputText,
  type ResponseFunctionTool,
  type ResponseItem,
  type ResponseObject,
  type ResponseRequest,
  type ResponseStreamEvent,
  type ResponseToolChoice,
  type ResponseUsage,
} from "@marketplace/shared/responses";
import type { ChatMessage } from "@marketplace/shared/tx";

export type OpenAiUpstreamApi = "responses" | "chat-completions";

export interface CallResponsesParams extends ResponseRequest {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  apiKey?: string;
  /** Operator output-token ceiling. The buyer's explicit limit is capped to this value. */
  maxTokens?: number;
  disableReasoning?: boolean;
  user?: string;
  upstreamApi?: OpenAiUpstreamApi;
  /** Optional full native Responses endpoint. */
  responsesUrl?: string;
  /** Collect native SSE even for buffered calls when the provider is streaming-only. */
  responsesStreamOnly?: boolean;
}

export interface OpenAiResult {
  response: ResponseObject;
  content: string;
  prompt_tokens: number;
  completion_tokens: number;
  wallclock_ms: number;
  cost_usd?: number;
}

export type OpenAiErrorReason = "openai_failure" | "openai_timeout" | "openai_malformed";

export class OpenAiError extends Error {
  public readonly reason: OpenAiErrorReason;

  constructor(reason: OpenAiErrorReason, message?: string) {
    super(message ?? reason);
    this.name = "OpenAiError";
    this.reason = reason;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error &&
    (error.name === "AbortError" || (error as Error & { code?: string }).code === "ABORT_ERR");
}

function objectValue(value: unknown, description: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OpenAiError("openai_malformed", `OpenAI ${description} was not an object`);
  }
  return value as Record<string, unknown>;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseUsage(raw: unknown): ResponseUsage | null {
  if (raw === null || raw === undefined) return null;
  const usage = objectValue(raw, "response usage");
  if (
    !finiteNonNegative(usage.input_tokens) ||
    !finiteNonNegative(usage.output_tokens) ||
    !finiteNonNegative(usage.total_tokens)
  ) {
    throw new OpenAiError("openai_malformed", "OpenAI response usage was missing canonical token counts");
  }
  return usage as ResponseUsage;
}

function parseNativeResponse(raw: unknown): ResponseObject {
  const value = objectValue(raw, "response");
  if (value.object !== "response" && value.error && typeof value.error === "object") {
    const upstreamError = value.error as Record<string, unknown>;
    throw new OpenAiError(
      "openai_failure",
      typeof upstreamError.message === "string" ? upstreamError.message : "OpenAI response failed",
    );
  }
  if (value.object !== "response") {
    throw new OpenAiError("openai_malformed", "OpenAI response object was not 'response'");
  }
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new OpenAiError("openai_malformed", "OpenAI response was missing id");
  }
  if (typeof value.created_at !== "number" || !Number.isFinite(value.created_at)) {
    throw new OpenAiError("openai_malformed", "OpenAI response was missing created_at");
  }
  if (typeof value.model !== "string" || value.model.length === 0) {
    throw new OpenAiError("openai_malformed", "OpenAI response was missing model");
  }
  if (
    value.status !== "completed" &&
    value.status !== "incomplete" &&
    value.status !== "failed" &&
    value.status !== "in_progress"
  ) {
    throw new OpenAiError("openai_malformed", "OpenAI response had an invalid status");
  }

  let output: ResponseItem[];
  try {
    output = normalizeResponseOutput(value.output);
  } catch (error) {
    throw new OpenAiError(
      "openai_malformed",
      `OpenAI response output was invalid: ${(error as Error)?.message ?? String(error)}`,
    );
  }
  const usage = parseUsage(value.usage);
  const incompleteDetails = value.incomplete_details;
  if (
    incompleteDetails !== null &&
    incompleteDetails !== undefined &&
    (!incompleteDetails ||
      typeof incompleteDetails !== "object" ||
      Array.isArray(incompleteDetails) ||
      typeof (incompleteDetails as Record<string, unknown>).reason !== "string")
  ) {
    throw new OpenAiError("openai_malformed", "OpenAI response had invalid incomplete_details");
  }
  const error = value.error;
  if (error !== null && error !== undefined && (!error || typeof error !== "object" || Array.isArray(error))) {
    throw new OpenAiError("openai_malformed", "OpenAI response had an invalid error");
  }

  return {
    ...value,
    id: value.id,
    object: "response",
    created_at: value.created_at,
    model: value.model,
    status: value.status,
    output,
    usage,
    error: (error ?? null) as Record<string, unknown> | null,
    incomplete_details: (incompleteDetails ?? null) as { reason: string } | null,
  };
}

function assertSuccessfulTerminal(response: ResponseObject): void {
  if (response.status === "failed") {
    const message = response.error && typeof response.error.message === "string"
      ? response.error.message
      : "OpenAI response failed";
    throw new OpenAiError("openai_failure", message);
  }
  if (response.status !== "completed" && response.status !== "incomplete") {
    throw new OpenAiError("openai_malformed", "OpenAI response was not terminal");
  }
  if (response.status === "completed" && response.output.length === 0) {
    throw new OpenAiError("openai_malformed", "OpenAI completed response produced no output");
  }
}

function effectiveMaxOutputTokens(buyerLimit: number | undefined, operatorLimit: number | undefined): number | undefined {
  const buyer = typeof buyerLimit === "number" && buyerLimit > 0 ? buyerLimit : undefined;
  const operator = typeof operatorLimit === "number" && operatorLimit > 0 ? operatorLimit : undefined;
  if (buyer !== undefined && operator !== undefined) return Math.min(buyer, operator);
  return buyer ?? operator;
}

function endpoint(params: CallResponsesParams, api: OpenAiUpstreamApi): string {
  if (api === "responses" && params.responsesUrl?.trim()) return params.responsesUrl.trim();
  return `${params.baseUrl.replace(/\/+$/, "")}/v1/${api === "responses" ? "responses" : "chat/completions"}`;
}


function nativePayload(params: CallResponsesParams, stream: boolean): Record<string, unknown> {
  if (
    params.disableReasoning &&
    params.reasoning?.effort !== undefined &&
    params.reasoning.effort !== "none"
  ) {
    throw new OpenAiError(
      "openai_malformed",
      "Reasoning effort must be 'none' when reasoning is disabled",
    );
  }
  const payload: Record<string, unknown> = {
    model: params.model,
    input: params.input,
    stream,
    store: false,
    include: ["reasoning.encrypted_content"],
  };
  for (const key of [
    "instructions",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "reasoning",
    "text",
    "temperature",
    "top_p",
  ] as const) {
    if (params[key] !== undefined) payload[key] = params[key];
  }
  const maxOutputTokens = effectiveMaxOutputTokens(params.max_output_tokens, params.maxTokens);
  if (maxOutputTokens !== undefined) payload.max_output_tokens = maxOutputTokens;
  if (params.disableReasoning) {
    payload.reasoning = {
      ...(params.reasoning ?? {}),
      effort: "none",
    };
  }
  if (params.user) payload.user = params.user;
  return payload;
}

function chatTool(tool: ResponseFunctionTool): Record<string, unknown> {
  const { type: _type, name, description, parameters, strict } = tool;
  return {
    type: "function",
    function: {
      name,
      ...(description === undefined ? {} : { description }),
      ...(parameters === undefined ? {} : { parameters }),
      ...(strict === undefined ? {} : { strict }),
    },
  };
}

function chatToolChoice(choice: ResponseToolChoice): unknown {
  if (typeof choice === "string") return choice;
  return { type: "function", function: { name: choice.name } };
}

function chatPayload(params: CallResponsesParams, stream: boolean): Record<string, unknown> {
  const compatibilityError = responseCompatibilityError(
    params,
    "chat-completions",
    params.disableReasoning,
  );
  if (compatibilityError) {
    throw new OpenAiError(
      "openai_malformed",
      `${compatibilityError.param}: ${compatibilityError.message}`,
    );
  }

  let messages: ChatMessage[];
  try {
    messages = responseInputToChatMessages(params.input, params.instructions);
  } catch (error) {
    throw new OpenAiError(
      "openai_malformed",
      `The chat-completions upstream cannot replay this input: ${(error as Error)?.message ?? String(error)}`,
    );
  }

  const payload: Record<string, unknown> = { model: params.model, messages, stream };
  if (stream) payload.stream_options = { include_usage: true };
  const maxOutputTokens = effectiveMaxOutputTokens(params.max_output_tokens, params.maxTokens);
  if (maxOutputTokens !== undefined) payload.max_tokens = maxOutputTokens;
  if (params.tools?.length) payload.tools = params.tools.map(chatTool);
  if (params.tool_choice !== undefined) payload.tool_choice = chatToolChoice(params.tool_choice);
  if (params.parallel_tool_calls !== undefined) payload.parallel_tool_calls = params.parallel_tool_calls;
  if (params.temperature !== undefined) payload.temperature = params.temperature;
  if (params.top_p !== undefined) payload.top_p = params.top_p;
  const responseFormat = responseTextToChatResponseFormat(params.text);
  if (responseFormat !== undefined) payload.response_format = responseFormat;
  if (params.disableReasoning) payload.reasoning = { enabled: false };
  if (params.user) payload.user = params.user;
  return payload;
}

async function fetchUpstream(
  params: CallResponsesParams,
  api: OpenAiUpstreamApi,
  stream: boolean,
  signal: AbortSignal,
): Promise<Response> {
  try {
    return await fetch(endpoint(params, api), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(stream ? { accept: "text/event-stream" } : {}),
        ...(params.apiKey ? { authorization: `Bearer ${params.apiKey}` } : {}),
      },
      body: JSON.stringify(api === "responses" ? nativePayload(params, stream) : chatPayload(params, stream)),
      signal,
    });
  } catch (error) {
    if (error instanceof OpenAiError) throw error;
    if (isAbortError(error)) {
      throw new OpenAiError("openai_timeout", `OpenAI request exceeded ${params.timeoutMs}ms`);
    }
    throw new OpenAiError(
      "openai_failure",
      `OpenAI fetch failed: ${(error as Error)?.message ?? String(error)}`,
    );
  }
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  let detail = "";
  try {
    detail = await response.text();
  } catch {
    // The status remains authoritative when the error body cannot be read.
  }
  throw new OpenAiError(
    "openai_failure",
    `OpenAI returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
  );
}

function resultFromResponse(response: ResponseObject, startedAt: number, costUsd?: number): OpenAiResult {
  return {
    response,
    content: responseOutputText(response.output),
    prompt_tokens: response.usage?.input_tokens ?? 0,
    completion_tokens: response.usage?.output_tokens ?? 0,
    wallclock_ms: Date.now() - startedAt,
    ...(costUsd === undefined ? {} : { cost_usd: costUsd }),
  };
}

function costFromUsage(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const cost = (raw as Record<string, unknown>).cost;
  return finiteNonNegative(cost) ? cost : undefined;
}

function chatUsage(raw: unknown): ResponseUsage | null {
  if (raw === undefined || raw === null) return null;
  const value = objectValue(raw, "chat completion usage");
  const inputTokens = finiteNonNegative(value.prompt_tokens) ? value.prompt_tokens : 0;
  const outputTokens = finiteNonNegative(value.completion_tokens) ? value.completion_tokens : 0;
  const totalTokens = finiteNonNegative(value.total_tokens) ? value.total_tokens : inputTokens + outputTokens;
  return {
    ...value,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    ...(value.prompt_tokens_details && typeof value.prompt_tokens_details === "object"
      ? { input_tokens_details: value.prompt_tokens_details as Record<string, unknown> }
      : {}),
    ...(value.completion_tokens_details && typeof value.completion_tokens_details === "object"
      ? { output_tokens_details: value.completion_tokens_details as Record<string, unknown> }
      : {}),
  };
}

interface ChatTerminal {
  response: ResponseObject;
  costUsd?: number;
}

function chatTerminal(raw: unknown, fallbackModel: string): ChatTerminal {
  const value = objectValue(raw, "chat completion");
  if (value.error && typeof value.error === "object") {
    const upstreamError = value.error as Record<string, unknown>;
    throw new OpenAiError(
      "openai_failure",
      typeof upstreamError.message === "string" ? upstreamError.message : "OpenAI chat completion failed",
    );
  }
  const choices = value.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new OpenAiError("openai_malformed", "OpenAI chat completion was missing choices");
  }
  const choice = objectValue(choices[0], "chat completion choice");
  const message = objectValue(choice.message, "chat completion message");
  const finishReason = choice.finish_reason;
  if (typeof finishReason !== "string" || finishReason.length === 0) {
    throw new OpenAiError("openai_malformed", "OpenAI chat completion was missing finish_reason");
  }

  if (message.reasoning_content !== undefined && message.reasoning_content !== null) {
    throw new OpenAiError(
      "openai_malformed",
      "The chat-completions upstream returned reasoning_content that cannot be replayed safely",
    );
  }
  const output: ResponseItem[] = [];
  const contentParts: Array<Record<string, unknown>> = [];
  if (typeof message.content === "string" && message.content.length > 0) {
    contentParts.push({ type: "output_text", text: message.content, annotations: [] });
  } else if (message.content !== null && message.content !== undefined && message.content !== "") {
    throw new OpenAiError("openai_malformed", "OpenAI chat completion content was invalid");
  }
  if (typeof message.refusal === "string" && message.refusal.length > 0) {
    contentParts.push({ type: "refusal", refusal: message.refusal });
  } else if (message.refusal !== null && message.refusal !== undefined && message.refusal !== "") {
    throw new OpenAiError("openai_malformed", "OpenAI chat completion refusal was invalid");
  }
  if (contentParts.length > 0) {
    output.push({
      type: "message",
      role: "assistant",
      status: "completed",
      content: contentParts,
    } as ResponseItem);
  }

  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) {
      throw new OpenAiError("openai_malformed", "OpenAI chat completion tool_calls was invalid");
    }
    for (const rawCall of message.tool_calls) {
      const call = objectValue(rawCall, "chat completion tool call");
      const fn = objectValue(call.function, "chat completion tool function");
      if (
        call.type !== "function" ||
        typeof call.id !== "string" || call.id.length === 0 ||
        typeof fn.name !== "string" || fn.name.length === 0 ||
        typeof fn.arguments !== "string"
      ) {
        throw new OpenAiError("openai_malformed", "OpenAI chat completion tool call was invalid");
      }
      output.push({
        type: "function_call",
        id: call.id,
        call_id: call.id,
        name: fn.name,
        arguments: fn.arguments,
        status: "completed",
      });
    }
  }
  const status = finishReason === "length" || finishReason === "content_filter"
    ? "incomplete" as const
    : "completed" as const;
  if (output.length === 0 && status === "completed") {
    throw new OpenAiError("openai_malformed", "OpenAI chat completion produced no output");
  }
  const reason = finishReason === "length" ? "max_output_tokens" : finishReason;
  const usage = chatUsage(value.usage);
  const response = createResponse({
    id: typeof value.id === "string" && value.id.length > 0 ? value.id : `resp_${crypto.randomUUID()}`,
    model: typeof value.model === "string" && value.model.length > 0 ? value.model : fallbackModel,
    created_at: finiteNonNegative(value.created) ? value.created : Math.floor(Date.now() / 1000),
    output,
    usage,
    status,
    incomplete_details: status === "incomplete" ? { reason } : null,
    error: null,
  });
  return { response, costUsd: costFromUsage(value.usage) };
}

export async function callResponses(params: CallResponsesParams): Promise<OpenAiResult> {
  const api = params.upstreamApi ?? "responses";
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    if (api === "responses" && params.responsesStreamOnly) {
      return await callNativeResponsesStream(params, undefined, startedAt, controller);
    }
    const upstream = await fetchUpstream(params, api, false, controller.signal);
    await assertOk(upstream);
    let parsed: unknown;
    try {
      parsed = await upstream.json();
    } catch (error) {
      if (isAbortError(error)) {
        throw new OpenAiError("openai_timeout", `OpenAI request exceeded ${params.timeoutMs}ms`);
      }
      if (error instanceof TypeError) {
        throw new OpenAiError("openai_failure", `OpenAI response read failed: ${error.message}`);
      }
      throw new OpenAiError(
        "openai_malformed",
        `OpenAI response was not valid JSON: ${(error as Error)?.message ?? String(error)}`,
      );
    }
    if (api === "chat-completions") {
      const terminal = chatTerminal(parsed, params.model);
      return resultFromResponse(terminal.response, startedAt, terminal.costUsd);
    }
    const response = parseNativeResponse(parsed);
    assertSuccessfulTerminal(response);
    return resultFromResponse(response, startedAt, costFromUsage(response.usage));
  } finally {
    clearTimeout(timer);
  }
}


async function callNativeResponsesStream(
  params: CallResponsesParams,
  onEvent: ((event: ResponseStreamEvent) => void) | undefined,
  startedAt: number,
  controller: AbortController,
): Promise<OpenAiResult> {
  const upstream = await fetchUpstream(params, "responses", true, controller.signal);
  await assertOk(upstream);
  if (!upstream.body) {
    throw new OpenAiError("openai_malformed", "OpenAI streaming response had no body");
  }

  let terminal: ResponseObject | undefined;
  let terminalEvent: ResponseStreamEvent | undefined;
  const completedOutput = new Map<number, ResponseItem>();
  let lastOutputIndex = -1;
  try {
    for await (const event of readResponseEvents(upstream.body)) {
      if (event.type === "error" || event.type === "response.failed") {
        throw new OpenAiError("openai_failure", "OpenAI response stream failed");
      }
      if (event.type === "response.output_item.done") {
        const index = event.output_index;
        if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || completedOutput.has(index)) {
          throw new OpenAiError("openai_malformed", "OpenAI stream had an invalid or duplicate output index");
        }
        const [item] = normalizeResponseOutput([event.item]);
        completedOutput.set(index, item);
        lastOutputIndex = Math.max(lastOutputIndex, index);
        onEvent?.({ ...event, item });
        continue;
      }
      if (event.type === "response.completed" || event.type === "response.incomplete") {
        if (terminal) {
          throw new OpenAiError("openai_malformed", "OpenAI response stream had multiple terminal events");
        }
        const metadata = objectValue(event.response, "terminal response");
        let aggregate: unknown = metadata;
        if (Array.isArray(metadata.output) && metadata.output.length === 0 && completedOutput.size > 0) {
          // Codex carries complete items in output_item.done without repeating
          // them in the terminal metadata. Never reconstruct them from deltas.
          if (lastOutputIndex !== completedOutput.size - 1) {
            throw new OpenAiError("openai_malformed", "OpenAI stream omitted a completed output item");
          }
          const output: ResponseItem[] = [];
          for (let index = 0; index < completedOutput.size; index++) output.push(completedOutput.get(index)!);
          aggregate = { ...metadata, output };
        }
        terminal = parseNativeResponse(aggregate);
        if (
          (event.type === "response.completed" && terminal.status !== "completed") ||
          (event.type === "response.incomplete" && terminal.status !== "incomplete")
        ) {
          throw new OpenAiError("openai_malformed", "OpenAI terminal event disagreed with response status");
        }
        assertSuccessfulTerminal(terminal);
        terminalEvent = { ...event, response: terminal };
        continue;
      }
      onEvent?.(event);
    }
  } catch (error) {
    if (error instanceof OpenAiError) throw error;
    if (isAbortError(error)) {
      throw new OpenAiError("openai_timeout", `OpenAI stream exceeded ${params.timeoutMs}ms`);
    }
    if (error instanceof TypeError) {
      throw new OpenAiError("openai_failure", `OpenAI stream read failed: ${error.message}`);
    }
    throw new OpenAiError(
      "openai_malformed",
      `OpenAI response stream was malformed: ${(error as Error)?.message ?? String(error)}`,
    );
  }
  if (!terminal || !terminalEvent) {
    throw new OpenAiError("openai_malformed", "OpenAI response stream ended without a terminal event");
  }
  onEvent?.(terminalEvent);
  return resultFromResponse(terminal, startedAt, costFromUsage(terminal.usage));
}

interface ChatStreamState {
  id: string;
  model: string;
  createdAt: number;
  text: string;
  refusal: string;
  contentOrder: Array<"text" | "refusal">;
  finishReason?: string;
  usage: ResponseUsage | null;
  costUsd?: number;
  toolCalls: Map<number, { id: string; name: string; arguments: string }>;
}

function parseChatChunk(raw: unknown, state: ChatStreamState): Array<{ kind: "text" | "refusal"; delta: string }> {
  const value = objectValue(raw, "chat stream chunk");
  if (typeof value.id === "string" && value.id.length > 0) state.id = value.id;
  if (typeof value.model === "string" && value.model.length > 0) state.model = value.model;
  if (finiteNonNegative(value.created)) state.createdAt = value.created;
  if (value.usage !== undefined && value.usage !== null) {
    state.usage = chatUsage(value.usage);
    state.costUsd = costFromUsage(value.usage);
  }
  if (value.error && typeof value.error === "object") {
    const upstreamError = value.error as Record<string, unknown>;
    throw new OpenAiError(
      "openai_failure",
      typeof upstreamError.message === "string" ? upstreamError.message : "OpenAI chat stream failed",
    );
  }
  if (!Array.isArray(value.choices)) {
    throw new OpenAiError("openai_malformed", "OpenAI chat stream chunk was missing choices");
  }
  if (value.choices.length === 0) return [];
  const choice = objectValue(value.choices[0], "chat stream choice");
  if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
    if (typeof choice.finish_reason !== "string" || choice.finish_reason.length === 0) {
      throw new OpenAiError("openai_malformed", "OpenAI chat stream finish_reason was invalid");
    }
    if (state.finishReason) {
      throw new OpenAiError("openai_malformed", "OpenAI chat stream had multiple finish reasons");
    }
    state.finishReason = choice.finish_reason;
  }
  if (choice.delta === undefined || choice.delta === null) return [];
  const delta = objectValue(choice.delta, "chat stream delta");
  if (delta.reasoning_content !== undefined && delta.reasoning_content !== null) {
    throw new OpenAiError(
      "openai_malformed",
      "The chat-completions upstream returned reasoning_content that cannot be replayed safely",
    );
  }
  const emitted: Array<{ kind: "text" | "refusal"; delta: string }> = [];
  if (delta.content !== undefined && delta.content !== null) {
    if (typeof delta.content !== "string") {
      throw new OpenAiError("openai_malformed", "OpenAI chat stream content delta was invalid");
    }
    if (delta.content) {
      if (state.text === "") state.contentOrder.push("text");
      state.text += delta.content;
      emitted.push({ kind: "text", delta: delta.content });
    }
  }
  if (delta.refusal !== undefined && delta.refusal !== null) {
    if (typeof delta.refusal !== "string") {
      throw new OpenAiError("openai_malformed", "OpenAI chat stream refusal delta was invalid");
    }
    if (delta.refusal) {
      if (state.refusal === "") state.contentOrder.push("refusal");
      state.refusal += delta.refusal;
      emitted.push({ kind: "refusal", delta: delta.refusal });
    }
  }
  if (delta.tool_calls !== undefined) {
    if (!Array.isArray(delta.tool_calls)) {
      throw new OpenAiError("openai_malformed", "OpenAI chat stream tool_calls delta was invalid");
    }
    for (const rawCall of delta.tool_calls) {
      const call = objectValue(rawCall, "chat stream tool call delta");
      if (!Number.isInteger(call.index) || (call.index as number) < 0) {
        throw new OpenAiError("openai_malformed", "OpenAI chat stream tool call index was invalid");
      }
      const index = call.index as number;
      const current = state.toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
      if (call.id !== undefined) {
        if (typeof call.id !== "string" || call.id.length === 0) {
          throw new OpenAiError("openai_malformed", "OpenAI chat stream tool call id was invalid");
        }
        current.id = call.id;
      }
      if (call.function !== undefined) {
        const fn = objectValue(call.function, "chat stream tool function delta");
        if (fn.name !== undefined) {
          if (typeof fn.name !== "string" || fn.name.length === 0) {
            throw new OpenAiError("openai_malformed", "OpenAI chat stream tool name was invalid");
          }
          current.name = fn.name;
        }
        if (fn.arguments !== undefined) {
          if (typeof fn.arguments !== "string") {
            throw new OpenAiError("openai_malformed", "OpenAI chat stream tool arguments were invalid");
          }
          current.arguments += fn.arguments;
        }
      }
      state.toolCalls.set(index, current);
    }
  }
  return emitted;
}

async function* readChatSse(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawDone = false;

  const parseFrame = (frame: string): unknown | undefined => {
    const data: string[] = [];
    for (const rawLine of frame.split(/\r?\n/)) {
      if (rawLine.startsWith(":")) continue;
      const colon = rawLine.indexOf(":");
      const field = colon < 0 ? rawLine : rawLine.slice(0, colon);
      let value = colon < 0 ? "" : rawLine.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") data.push(value);
    }
    if (data.length === 0) return undefined;
    const joined = data.join("\n");
    if (joined.trim() === "[DONE]") return "[DONE]";
    try {
      return JSON.parse(joined);
    } catch (error) {
      throw new OpenAiError(
        "openai_malformed",
        `OpenAI chat stream contained invalid JSON: ${(error as Error).message}`,
      );
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match || match.index === undefined) break;
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const parsed = parseFrame(frame);
        if (parsed === "[DONE]") {
          sawDone = true;
        } else if (parsed !== undefined) {
          if (sawDone) {
            throw new OpenAiError("openai_malformed", "OpenAI chat stream sent data after [DONE]");
          }
          yield parsed;
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const parsed = parseFrame(buffer);
      if (parsed === "[DONE]") sawDone = true;
      else if (parsed !== undefined) yield parsed;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function chatStreamResponse(state: ChatStreamState): ResponseObject {
  if (!state.finishReason) {
    throw new OpenAiError("openai_malformed", "OpenAI chat stream ended without a terminal finish reason");
  }
  const output: ResponseItem[] = [];
  const content: Array<Record<string, unknown>> = state.contentOrder.map((kind) =>
    kind === "text"
      ? { type: "output_text", text: state.text, annotations: [] }
      : { type: "refusal", refusal: state.refusal }
  );
  if (content.length) {
    output.push({
      type: "message",
      id: `msg_${state.id}`,
      role: "assistant",
      status: "completed",
      content,
    } as ResponseItem);
  }
  for (const [, call] of [...state.toolCalls.entries()].sort(([a], [b]) => a - b)) {
    if (!call.id || !call.name) {
      throw new OpenAiError("openai_malformed", "OpenAI chat stream ended with an incomplete tool call");
    }
    output.push({
      type: "function_call",
      id: call.id,
      call_id: call.id,
      name: call.name,
      arguments: call.arguments,
      status: "completed",
    });
  }
  const incomplete = state.finishReason === "length" || state.finishReason === "content_filter";
  if (output.length === 0 && !incomplete) {
    throw new OpenAiError("openai_malformed", "OpenAI chat stream produced no output");
  }
  return createResponse({
    id: state.id,
    model: state.model,
    created_at: state.createdAt,
    output,
    usage: state.usage,
    status: incomplete ? "incomplete" : "completed",
    incomplete_details: incomplete
      ? { reason: state.finishReason === "length" ? "max_output_tokens" : "content_filter" }
      : null,
    error: null,
  });
}

async function callChatCompletionsStream(
  params: CallResponsesParams,
  onEvent: (event: ResponseStreamEvent) => void,
  startedAt: number,
  controller: AbortController,
): Promise<OpenAiResult> {
  const upstream = await fetchUpstream(params, "chat-completions", true, controller.signal);
  await assertOk(upstream);
  if (!upstream.body) {
    throw new OpenAiError("openai_malformed", "OpenAI streaming response had no body");
  }
  const state: ChatStreamState = {
    id: `resp_${crypto.randomUUID()}`,
    model: params.model,
    createdAt: Math.floor(Date.now() / 1000),
    text: "",
    refusal: "",
    contentOrder: [],
    usage: null,
    toolCalls: new Map(),
  };
  let sequence = 0;
  let created = false;
  let messageStarted = false;
  const startedContent = new Set<"text" | "refusal">();
  const emit = (event: ResponseStreamEvent): void => {
    onEvent({ ...event, sequence_number: sequence++ });
  };
  const ensureCreated = (): void => {
    if (created) return;
    created = true;
    emit({
      type: "response.created",
      response: createResponse({
        id: state.id,
        model: state.model,
        created_at: state.createdAt,
        output: [],
        usage: null,
        status: "in_progress",
      }),
    });
    emit({
      type: "response.in_progress",
      response: createResponse({
        id: state.id,
        model: state.model,
        created_at: state.createdAt,
        output: [],
        usage: null,
        status: "in_progress",
      }),
    });
  };

  try {
    for await (const chunk of readChatSse(upstream.body)) {
      const deltas = parseChatChunk(chunk, state);
      ensureCreated();
      for (const delta of deltas) {
        if (!messageStarted) {
          messageStarted = true;
          emit({
            type: "response.output_item.added",
            output_index: 0,
            item: {
              type: "message",
              id: `msg_${state.id}`,
              role: "assistant",
              status: "in_progress",
              content: [],
            },
          });
        }
        const contentIndex = state.contentOrder.indexOf(delta.kind);
        if (!startedContent.has(delta.kind)) {
          startedContent.add(delta.kind);
          emit({
            type: "response.content_part.added",
            item_id: `msg_${state.id}`,
            output_index: 0,
            content_index: contentIndex,
            part: delta.kind === "text"
              ? { type: "output_text", text: "", annotations: [] }
              : { type: "refusal", refusal: "" },
          });
        }
        emit(delta.kind === "text"
          ? {
              type: "response.output_text.delta",
              item_id: `msg_${state.id}`,
              output_index: 0,
              content_index: contentIndex,
              delta: delta.delta,
            }
          : {
              type: "response.refusal.delta",
              item_id: `msg_${state.id}`,
              output_index: 0,
              content_index: contentIndex,
              delta: delta.delta,
            });
      }
    }
  } catch (error) {
    if (error instanceof OpenAiError) throw error;
    if (isAbortError(error)) {
      throw new OpenAiError("openai_timeout", `OpenAI stream exceeded ${params.timeoutMs}ms`);
    }
    throw new OpenAiError(
      "openai_failure",
      `OpenAI stream read failed: ${(error as Error)?.message ?? String(error)}`,
    );
  }

  const response = chatStreamResponse(state);
  ensureCreated();
  // Chat Completions has no typed item lifecycle. Emit canonical buffered
  // completion events. Text/refusal additions and deltas were emitted live.
  for (const event of responseEvents(response)) {
    const item = event.item as ResponseItem | undefined;
    if (
      event.type === "response.created" ||
      event.type === "response.in_progress" ||
      event.type === "response.output_text.delta" ||
      event.type === "response.refusal.delta" ||
      event.type === "response.content_part.added" ||
      (event.type === "response.output_item.added" && item?.type === "message") ||
      event.type === "response.completed" ||
      event.type === "response.incomplete"
    ) continue;
    emit(event);
  }
  emit({ type: response.status === "incomplete" ? "response.incomplete" : "response.completed", response });
  return resultFromResponse(response, startedAt, state.costUsd);
}

export async function callResponsesStream(
  params: CallResponsesParams,
  onEvent: (event: ResponseStreamEvent) => void,
): Promise<OpenAiResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    return (params.upstreamApi ?? "responses") === "responses"
      ? await callNativeResponsesStream(params, onEvent, startedAt, controller)
      : await callChatCompletionsStream(params, onEvent, startedAt, controller);
  } finally {
    clearTimeout(timer);
  }
}
