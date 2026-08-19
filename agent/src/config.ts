/**
 * supplier/src/config.ts — Load and validate supplier configuration from env.
 *
 * loadConfig(env) is a pure function (takes a Record<string, string> rather than
 * reading process.env directly) so tests can inject fake environments.
 *
 * Required env vars:
 *   SUPPLIER_PRIV_KEY_HEX  — 64-char hex Ed25519 private key
 *   OGMIOS_URL             — ws:// or wss:// URL
 *   ADVERT_REF             — "<64hex>#<int>" OutputReference to the supplier's advert UTxO
 *   NETWORK_ID             — "0" (testnet) or "1" (mainnet)
 *
 * Required for CAPABILITY_KIND="chat" (default) + LLM_BACKEND="ollama" (default):
 *   OLLAMA_URL             — http:// URL for local Ollama
 *
 * Required for CAPABILITY_KIND="chat" + LLM_BACKEND="openai":
 *   OPENAI_BASE_URL        — http(s):// URL for an OpenAI-compatible /v1/chat/completions
 *                            host. Examples: ChatMock localhost proxy (Codex OAuth),
 *                            OpenRouter (https://openrouter.ai/api), or the HuggingFace
 *                            Inference Providers router (https://router.huggingface.co).
 *                            See docs/HUGGINGFACE_ROUTER_SETUP.md for the HF preset.
 *
 * Required for CAPABILITY_KIND="tts":
 *   PIPER_URL              — http(s):// URL for the openedai-speech-min PiperTTS host
 *
 * Optional:
 *   CAPABILITY_KIND        — "chat" (default) or "tts". Selects which upstream
 *                            adapter is loaded and which HTTP route is mounted.
 *                            The route handler still validates the on-chain
 *                            advert's capability_id; this env just decides
 *                            which dispatch lives in the process.
 *   LLM_BACKEND            — "ollama" (default) or "openai". Selects which HTTP
 *                            client the chat job runner uses. Only meaningful
 *                            when CAPABILITY_KIND="chat".
 *   PORT                   — listen port (default 8080)
 *   OLLAMA_TIMEOUT_MS      — ollama request timeout in ms (default 120_000)
 *   OPENAI_TIMEOUT_MS      — openai request timeout in ms (default 180_000 — GPT
 *                            first-token latency is longer than local Ollama)
 *   OPENAI_SESSION_PASSTHROUGH
 *                          — "1" switches chat-session turns to the stateful-
 *                            upstream contract (OpenClaw): escrow ref as the
 *                            OpenAI `user` field + delta-only messages per turn.
 *                            Strict "1" only. Default off. Requires
 *                            CAPABILITY_KIND="chat-session".
 *   OPENAI_MODEL_OVERRIDE  — fixed upstream model id sent instead of the
 *                            advert's buyer-facing model (OpenClaw accepts only
 *                            "openclaw" / "openclaw/<agentId>"). Default unset.
 *   PIPER_TIMEOUT_MS       — piper request timeout in ms (default 120_000)
 *   LIVE_CHAIN             — "1" opts in to live-chain submit/await (default off).
 *                            Any other value (including "true", "yes", "TRUE")
 *                            keeps the supplier in read-only mode for safety.
 *   WALLET_HEALTH_INTERVAL_MS
 *                          — periodic wallet self-consolidate tick interval
 *                            (default 600_000 = 10 min). "0" disables the
 *                            ticker. Only fires while LIVE_CHAIN=1.
 *
 * On error: throws Error whose message names the offending field (matches
 * supplier-config.test.ts assertion that error message mentions field name).
 */

const HEX64_RE = /^[0-9a-fA-F]{64}$/;
const TX_HASH_RE = /^[0-9a-fA-F]{64}$/;
const NON_NEG_INT_RE = /^(?:0|[1-9]\d*)$/;
const POS_INT_RE = /^[1-9]\d*$/;

/** Lowercased hostname of a URL, or "" if it doesn't parse. */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export interface AdvertRef {
  txHash: string;
  index: number;
}

/** Capability the supplier is configured to serve.
 *   "chat"         — one-off `llm.text.generate.v1` (single prompt → single completion)
 *   "tts"          — `audio.synthesize.piper.v1`
 *   "chat-session" — multi-turn `llm.chat.v1` (escrow bookends, off-chain turns,
 *                    streaming). Requires LLM_BACKEND="openai".
 *   "ocr"          — model-scoped `ocr.page.extract.<model-slug>.v1` (one page
 *                    image → one extraction). Upstream is an OpenAI-compatible
 *                    VISION endpoint (OPENAI_BASE_URL), e.g. vLLM serving
 *                    datalab-to/chandra-ocr-2. */
export type CapabilityKind = "chat" | "tts" | "chat-session" | "ocr" | "custom";

/** Served-checkpoint probe cadence for the ocr capability.
 *   "per_job" — probe the upstream before every Claim (default when
 *               REVISION_PROBE_URL is set, and always the default for the
 *               datalab upstream, whose health route is derived).
 *   "off"     — no probing. */
export type RevisionProbeMode = "per_job" | "off";

/** Upstream flavor for the ocr capability.
 *   "openai-vision" — OpenAI-compatible vision endpoint (vLLM self-hosting;
 *                     supports the revision-pin attestation probe).
 *   "datalab"       — Datalab hosted document API (submit + poll; liveness
 *                     probe only — hosted supply has no checkpoint to pin). */
export type OcrUpstream = "openai-vision" | "datalab";

/** LLM backend selected for the chat capability. */
export type LlmBackend = "ollama" | "openai";

/** Chain settlement mode for chat sessions.
 *   "full"   — Claim at start, Submit receipt at end (buyer Accepts). Default.
 *   "ticket" — the buyer's escrow post is the only chain op; the supplier
 *              verifies it as an entry ticket but never Claims/Submits, and
 *              the buyer's sweeper Reclaims the Open escrow after deliver_by. */
export type ChatSettleMode = "full" | "ticket";

export interface SupplierConfig {
  supplierPrivKeyHex: string;
  ogmiosUrl: string;
  /** Empty string when capabilityKind="tts" or llmBackend="openai". */
  ollamaUrl: string;
  /** Empty string when capabilityKind="tts" or llmBackend="ollama". */
  openaiBaseUrl: string;
  /**
   * Bearer token forwarded as `Authorization: Bearer <key>` when llmBackend="openai".
   * Empty string means no header is sent (correct for ChatMock and other localhost
   * proxies). Required for hosted OpenAI-compatible APIs (DeepSeek, OpenAI, etc.).
   */
  openaiApiKey: string;
  /**
   * When true, upstream OpenAI/OpenRouter calls send `reasoning:{enabled:false}`
   * to disable "thinking" tokens (faster/cheaper straight answers; avoids
   * reasoning starving the completion into a length-truncated empty answer).
   * Set via OPENAI_REASONING=off. Default false. OpenRouter-only.
   */
  openaiReasoningDisabled: boolean;
  /**
   * Optional `max_tokens` ceiling forwarded on upstream calls. 0 = omit (the
   * provider then grants the max available = context − prompt). Must stay below
   * the model context or the provider 400s (e.g. kimi context = 262144).
   */
  openaiMaxTokens: number;
  /**
   * When true, chat-session turns speak the STATEFUL-upstream contract
   * (e.g. an OpenClaw gateway): each turn sends the escrow ref as the OpenAI
   * `user` field (OpenClaw keys one persistent agent session per `user`, so
   * browser/tool state survives across turns) and sends ONLY the current
   * turn's delta messages — the upstream session carries the history, and
   * re-sending the full transcript would duplicate it into the upstream
   * context every turn. The supplier still accumulates the full transcript
   * locally for the receipt. Env: OPENAI_SESSION_PASSTHROUGH="1". Default
   * off (stateless upstreams get the full transcript each turn). Requires
   * capabilityKind="chat-session".
   */
  openaiSessionPassthrough: boolean;
  /**
   * When non-empty, sent as the upstream `model` instead of the advert's
   * model id. For upstreams that reject arbitrary model strings — OpenClaw's
   * chat-completions endpoint 400s on anything but "openclaw" or
   * "openclaw/<agentId>" — while the advert carries the buyer-facing id the
   * gateway routes on. Env: OPENAI_MODEL_OVERRIDE. Default "" (advert model
   * sent verbatim).
   */
  openaiModelOverride: string;
  /** Empty string when capabilityKind="chat". */
  piperUrl: string;
  advertRef: AdvertRef;
  networkId: 0 | 1;
  port: number;
  ollamaTimeoutMs: number;
  openaiTimeoutMs: number;
  piperTimeoutMs: number;
  capabilityKind: CapabilityKind;
  llmBackend: LlmBackend;
  /**
   * Idle-timeout for an open chat session, ms. A session with no message
   * activity for this long is auto-ended (supplier Submits the transcript
   * receipt). Only meaningful for capabilityKind="chat-session". Default
   * 300_000 (5 min).
   */
  chatIdleTimeoutMs: number;
  /**
   * Concurrent chat-session slots (capabilityKind="chat-session" only).
   * Default 1 = legacy single-slot behavior.
   */
  maxChatSessions: number;
  /** Chain settlement mode for chat sessions. Default "full". */
  chatSettleMode: ChatSettleMode;
  /**
   * Upstream flavor for the ocr capability. Env: OCR_UPSTREAM
   * ("openai-vision" default | "datalab").
   */
  ocrUpstream: OcrUpstream;
  /** Datalab API key (X-API-Key). Required when ocrUpstream="datalab". */
  datalabApiKey: string;
  /** Datalab API origin. Env: DATALAB_BASE_URL, default https://www.datalab.to */
  datalabBaseUrl: string;
  /** Datalab quality mode: fast | balanced | accurate. Env: DATALAB_MODE. */
  datalabMode: string;
  /** Whole-call budget for submit+poll, ms. Env: DATALAB_TIMEOUT_MS. */
  datalabTimeoutMs: number;
  /**
   * Overrides the built-in per-format OCR instruction prompt when non-empty
   * (capabilityKind="ocr" + openai-vision upstream only). Env: OCR_PROMPT_OVERRIDE.
   */
  ocrPromptOverride: string;
  /**
   * Expected served-checkpoint SHA (40-hex) for the ocr upstream. When set
   * together with revisionProbeUrl, a probe mismatch refuses the Claim.
   * Env: HF_MODEL_REVISION. "" = no pin.
   */
  hfModelRevision: string;
  /**
   * Serving-runtime info route reporting the loaded checkpoint (TGI-style
   * /info or vLLM equivalent). Env: REVISION_PROBE_URL. "" = probing off.
   */
  revisionProbeUrl: string;
  /** Probe cadence; see RevisionProbeMode. Env: REVISION_PROBE_MODE. */
  revisionProbeMode: RevisionProbeMode;
  /**
   * Operator service endpoint for the custom capability. Required when
   * capabilityKind="custom" (the operator's black box). Env: SERVICE_URL.
   */
  serviceUrl: string;
  /** Custom-service request timeout, ms. Env: SERVICE_TIMEOUT_MS, default 120_000. */
  serviceTimeoutMs: number;
  /** Optional auth header value forwarded to the custom service. Env: SERVICE_AUTH_HEADER, default "". */
  serviceAuthHeader: string;
  /** Content-Type sent to the custom service. Env: SERVICE_CONTENT_TYPE, default "application/json". */
  serviceContentType: string;
  /**
   * The processing SLA the operator advertises, ms — the same number
   * `tx:post-advert` writes into the advert datum's max_processing_ms.
   * Required when capabilityKind="custom": createApp's SLA boot guard refuses
   * a SERVICE_TIMEOUT_MS that cannot nest inside it (minus the 30s deliver-by
   * grace), because such a supplier claims jobs it can never submit.
   * Env: ADVERT_MAX_PROCESSING_MS. 0 = unset (other capability kinds).
   */
  advertMaxProcessingMs: number;
  /**
   * When true, the supplier boots a LiveOgmiosProvider (real submitTx/awaitTx).
   * Default false → ReadOnlyOgmiosProvider (safe; no chain writes).
   * Only the literal env value "1" sets this to true.
   */
  liveChain: boolean;
  /**
   * Periodic wallet self-consolidate tick interval, ms. 0 disables the ticker.
   * Default 600_000 (10 min). Only fires while liveChain=true.
   */
  walletHealthIntervalMs: number;
}

function requireField(env: Record<string, string | undefined>, name: string): string {
  const v = env[name];
  if (v === undefined || v === null || v === "") {
    throw new Error(`loadConfig: missing required env var ${name}`);
  }
  return v;
}

export function parseAdvertRef(ref: string): AdvertRef {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new Error('parseAdvertRef: ref must be a non-empty "<txHash>#<index>" string');
  }
  const hashIdx = ref.indexOf("#");
  if (hashIdx < 0) {
    throw new Error('parseAdvertRef: missing "#" separator in advert ref');
  }
  const txHash = ref.slice(0, hashIdx);
  const indexStr = ref.slice(hashIdx + 1);
  if (!TX_HASH_RE.test(txHash)) {
    throw new Error("parseAdvertRef: txHash must be 64 hex chars (32 bytes)");
  }
  if (!NON_NEG_INT_RE.test(indexStr)) {
    throw new Error("parseAdvertRef: index must be a non-negative integer");
  }
  return { txHash, index: Number(indexStr) };
}

export function loadConfig(env: Record<string, string | undefined>): SupplierConfig {
  const supplierPrivKeyHex = requireField(env, "SUPPLIER_PRIV_KEY_HEX");
  if (!HEX64_RE.test(supplierPrivKeyHex)) {
    throw new Error("loadConfig: SUPPLIER_PRIV_KEY_HEX must be 64 hex chars (32 bytes)");
  }

  const ogmiosUrl = requireField(env, "OGMIOS_URL");

  // CAPABILITY_KIND drives whether OLLAMA_URL or PIPER_URL is required.
  // Default to "chat" so existing chat suppliers keep booting unchanged.
  const capKindStr = env.CAPABILITY_KIND ?? "chat";
  if (
    capKindStr !== "chat" &&
    capKindStr !== "tts" &&
    capKindStr !== "chat-session" &&
    capKindStr !== "ocr" &&
    capKindStr !== "custom"
  ) {
    throw new Error('loadConfig: CAPABILITY_KIND must be "chat", "tts", "chat-session", "ocr", or "custom"');
  }
  const capabilityKind: CapabilityKind = capKindStr;

  // LLM_BACKEND selects which HTTP client the chat job runner uses. Only
  // meaningful for capabilityKind="chat"; ignored when capabilityKind="tts".
  // Default "ollama" so existing chat suppliers keep booting unchanged.
  const llmBackendStr = env.LLM_BACKEND ?? "ollama";
  if (llmBackendStr !== "ollama" && llmBackendStr !== "openai") {
    throw new Error('loadConfig: LLM_BACKEND must be "ollama" or "openai"');
  }
  const llmBackend: LlmBackend = llmBackendStr;

  // Per-capability upstream URL — the OTHER capability's URL becomes
  // optional/unused. The route handler also validates the on-chain advert's
  // capability_id, so a misconfiguration here can't trick a TTS supplier into
  // serving chat traffic; this gate just keeps the process boot honest.
  let ollamaUrl = "";
  let openaiBaseUrl = "";
  let piperUrl = "";
  if (capabilityKind === "custom") {
    // The custom kind talks only to the operator's own service.
    ollamaUrl = env.OLLAMA_URL ?? "";
    openaiBaseUrl = env.OPENAI_BASE_URL ?? "";
    piperUrl = env.PIPER_URL ?? "";
  } else if (capabilityKind === "chat-session") {
    // Multi-turn chat streams via callOpenAiStream, which only speaks the
    // OpenAI-compatible wire format — so chat-session is openai-only.
    if (llmBackend !== "openai") {
      throw new Error('loadConfig: CAPABILITY_KIND="chat-session" requires LLM_BACKEND="openai"');
    }
    openaiBaseUrl = requireField(env, "OPENAI_BASE_URL");
    ollamaUrl = env.OLLAMA_URL ?? "";
    piperUrl = env.PIPER_URL ?? "";
  } else if (capabilityKind === "ocr") {
    // Upstream is either an OpenAI-compatible vision endpoint (self-hosted
    // vLLM; OPENAI_BASE_URL required) or the Datalab hosted API
    // (DATALAB_API_KEY required, validated below). Ollama and piper are
    // unused regardless of LLM_BACKEND.
    const upstream = env.OCR_UPSTREAM ?? "openai-vision";
    if (upstream === "openai-vision") {
      openaiBaseUrl = requireField(env, "OPENAI_BASE_URL");
    } else {
      openaiBaseUrl = env.OPENAI_BASE_URL ?? "";
    }
    ollamaUrl = env.OLLAMA_URL ?? "";
    piperUrl = env.PIPER_URL ?? "";
  } else if (capabilityKind === "chat") {
    if (llmBackend === "openai") {
      openaiBaseUrl = requireField(env, "OPENAI_BASE_URL");
      ollamaUrl = env.OLLAMA_URL ?? "";
    } else {
      ollamaUrl = requireField(env, "OLLAMA_URL");
      openaiBaseUrl = env.OPENAI_BASE_URL ?? "";
    }
    piperUrl = env.PIPER_URL ?? "";
  } else {
    piperUrl = requireField(env, "PIPER_URL");
    ollamaUrl = env.OLLAMA_URL ?? "";
    openaiBaseUrl = env.OPENAI_BASE_URL ?? "";
  }

  const advertRefStr = requireField(env, "ADVERT_REF");
  const advertRef = parseAdvertRef(advertRefStr);

  const networkIdStr = requireField(env, "NETWORK_ID");
  if (networkIdStr !== "0" && networkIdStr !== "1") {
    throw new Error('loadConfig: NETWORK_ID must be "0" (testnet) or "1" (mainnet)');
  }
  const networkId: 0 | 1 = networkIdStr === "1" ? 1 : 0;

  const portStr = env.PORT;
  let port = 8080;
  if (portStr !== undefined && portStr !== "") {
    if (!POS_INT_RE.test(portStr)) {
      throw new Error("loadConfig: PORT must be a positive integer");
    }
    port = Number(portStr);
  }

  const timeoutStr = env.OLLAMA_TIMEOUT_MS;
  let ollamaTimeoutMs = 120_000;
  if (timeoutStr !== undefined && timeoutStr !== "") {
    if (!POS_INT_RE.test(timeoutStr)) {
      throw new Error("loadConfig: OLLAMA_TIMEOUT_MS must be a positive integer");
    }
    ollamaTimeoutMs = Number(timeoutStr);
  }

  const openaiTimeoutStr = env.OPENAI_TIMEOUT_MS;
  let openaiTimeoutMs = 180_000;
  if (openaiTimeoutStr !== undefined && openaiTimeoutStr !== "") {
    if (!POS_INT_RE.test(openaiTimeoutStr)) {
      throw new Error("loadConfig: OPENAI_TIMEOUT_MS must be a positive integer");
    }
    openaiTimeoutMs = Number(openaiTimeoutStr);
  }

  const openaiApiKey = env.OPENAI_API_KEY ?? "";

  // OPENAI_REASONING — "off"/"false"/"0"/"no" disables OpenRouter reasoning
  // ("thinking") by sending reasoning:{enabled:false} on every upstream call.
  // Unset/any other value leaves the model's own default untouched (no param
  // sent). Only valid for OpenRouter-backed suppliers — do NOT set for
  // ChatMock/DeepSeek-direct, which reject the param.
  const reasoningRaw = (env.OPENAI_REASONING ?? "").trim().toLowerCase();
  const openaiReasoningDisabled =
    reasoningRaw === "off" ||
    reasoningRaw === "false" ||
    reasoningRaw === "0" ||
    reasoningRaw === "no";

  // HuggingFace router guard. The `reasoning:{enabled:false}` param is
  // OpenRouter-specific; the HF Inference Providers router
  // (router.huggingface.co) rejects it with HTTP 400 on EVERY request. This is
  // the easy footgun when copying an OpenRouter env to the HF preset, so fail
  // fast at boot with a clear message instead of 400-ing every job.
  // See docs/HUGGINGFACE_ROUTER_SETUP.md.
  if (
    llmBackend === "openai" &&
    openaiReasoningDisabled &&
    hostnameOf(openaiBaseUrl) === "router.huggingface.co"
  ) {
    throw new Error(
      "loadConfig: OPENAI_REASONING must be unset for the HuggingFace router " +
        "(OPENAI_BASE_URL=https://router.huggingface.co) — it rejects " +
        "reasoning:{enabled:false} with HTTP 400. Remove OPENAI_REASONING.",
    );
  }

  // OPENAI_MAX_TOKENS — optional hard ceiling forwarded as `max_tokens`. Unset
  // or non-positive omits it (provider grants max available = context − prompt).
  // Keep it below the model context (kimi 262144) or the provider 400s when
  // prompt+max_tokens exceeds context.
  const maxTokStr = env.OPENAI_MAX_TOKENS;
  let openaiMaxTokens = 0;
  if (maxTokStr !== undefined && maxTokStr !== "") {
    if (!POS_INT_RE.test(maxTokStr)) {
      throw new Error("loadConfig: OPENAI_MAX_TOKENS must be a positive integer");
    }
    openaiMaxTokens = Number(maxTokStr);
  }

  // OPENAI_SESSION_PASSTHROUGH — "1" switches chat-session turns to the
  // stateful-upstream contract (OpenClaw): escrow ref as the OpenAI `user`
  // field + delta-only messages (the upstream session carries history).
  // Strict "1" only, mirroring LIVE_CHAIN.
  const openaiSessionPassthrough = env.OPENAI_SESSION_PASSTHROUGH === "1";
  if (openaiSessionPassthrough && capabilityKind !== "chat-session") {
    throw new Error(
      'loadConfig: OPENAI_SESSION_PASSTHROUGH requires CAPABILITY_KIND="chat-session"',
    );
  }

  // OPENAI_MODEL_OVERRIDE — fixed upstream model id sent instead of the
  // advert's (buyer-facing) model. Needed when the upstream validates the
  // model field (OpenClaw accepts only "openclaw" / "openclaw/<agentId>").
  const openaiModelOverride = env.OPENAI_MODEL_OVERRIDE ?? "";

  // CHAT_IDLE_TIMEOUT_MS — idle auto-end window for chat sessions (default 5 min).
  const chatIdleStr = env.CHAT_IDLE_TIMEOUT_MS;
  let chatIdleTimeoutMs = 300_000;
  if (chatIdleStr !== undefined && chatIdleStr !== "") {
    if (!POS_INT_RE.test(chatIdleStr)) {
      throw new Error("loadConfig: CHAT_IDLE_TIMEOUT_MS must be a positive integer");
    }
    chatIdleTimeoutMs = Number(chatIdleStr);
  }

  // MAX_CHAT_SESSIONS — concurrent chat-session slots (default 1 = legacy
  // single-slot). Only meaningful for capabilityKind="chat-session".
  const maxSessionsStr = env.MAX_CHAT_SESSIONS;
  let maxChatSessions = 1;
  if (maxSessionsStr !== undefined && maxSessionsStr !== "") {
    if (!POS_INT_RE.test(maxSessionsStr)) {
      throw new Error("loadConfig: MAX_CHAT_SESSIONS must be a positive integer");
    }
    maxChatSessions = Number(maxSessionsStr);
  }
  if (maxChatSessions > 1 && capabilityKind !== "chat-session") {
    throw new Error('loadConfig: MAX_CHAT_SESSIONS > 1 requires CAPABILITY_KIND="chat-session"');
  }

  // CHAT_SETTLE_MODE — "full" (default; Claim at start, Submit receipt at end)
  // or "ticket" (the buyer's escrow post is the only chain op; the supplier
  // never Claims/Submits and the buyer reclaims the escrow after deliver_by).
  const settleModeStr = env.CHAT_SETTLE_MODE ?? "full";
  if (settleModeStr !== "full" && settleModeStr !== "ticket") {
    throw new Error('loadConfig: CHAT_SETTLE_MODE must be "full" or "ticket"');
  }
  if (settleModeStr === "ticket" && capabilityKind !== "chat-session") {
    throw new Error('loadConfig: CHAT_SETTLE_MODE="ticket" requires CAPABILITY_KIND="chat-session"');
  }
  const chatSettleMode: ChatSettleMode = settleModeStr;

  // OCR-capability extras. All optional; harmless when set on other kinds
  // (ignored by the chat/tts/chat-session paths).
  const ocrUpstreamStr = env.OCR_UPSTREAM ?? "openai-vision";
  if (ocrUpstreamStr !== "openai-vision" && ocrUpstreamStr !== "datalab") {
    throw new Error('loadConfig: OCR_UPSTREAM must be "openai-vision" or "datalab"');
  }
  const ocrUpstream: OcrUpstream = ocrUpstreamStr;

  const datalabApiKey = env.DATALAB_API_KEY ?? "";
  if (capabilityKind === "ocr" && ocrUpstream === "datalab" && datalabApiKey === "") {
    throw new Error('loadConfig: OCR_UPSTREAM="datalab" requires DATALAB_API_KEY');
  }
  const datalabBaseUrl = env.DATALAB_BASE_URL ?? "https://www.datalab.to";
  const datalabMode = env.DATALAB_MODE ?? "accurate";
  if (datalabMode !== "fast" && datalabMode !== "balanced" && datalabMode !== "accurate") {
    throw new Error('loadConfig: DATALAB_MODE must be "fast", "balanced", or "accurate"');
  }
  const datalabTimeoutStr = env.DATALAB_TIMEOUT_MS;
  let datalabTimeoutMs = 120_000;
  if (datalabTimeoutStr !== undefined && datalabTimeoutStr !== "") {
    if (!POS_INT_RE.test(datalabTimeoutStr)) {
      throw new Error("loadConfig: DATALAB_TIMEOUT_MS must be a positive integer");
    }
    datalabTimeoutMs = Number(datalabTimeoutStr);
  }

  const ocrPromptOverride = env.OCR_PROMPT_OVERRIDE ?? "";
  const hfModelRevision = env.HF_MODEL_REVISION ?? "";
  if (hfModelRevision !== "" && !/^[0-9a-fA-F]{40}$/.test(hfModelRevision)) {
    throw new Error("loadConfig: HF_MODEL_REVISION must be a 40-hex commit SHA when set");
  }
  const revisionProbeUrl = env.REVISION_PROBE_URL ?? "";
  // Datalab upstream: the health route is derived from DATALAB_BASE_URL, so
  // the liveness probe defaults ON without a REVISION_PROBE_URL. The
  // openai-vision upstream keeps the explicit-URL requirement.
  const probeDefault =
    ocrUpstream === "datalab" || revisionProbeUrl !== "" ? "per_job" : "off";
  const probeModeStr = env.REVISION_PROBE_MODE ?? probeDefault;
  if (probeModeStr !== "per_job" && probeModeStr !== "off") {
    throw new Error('loadConfig: REVISION_PROBE_MODE must be "per_job" or "off"');
  }
  if (probeModeStr === "per_job" && ocrUpstream === "openai-vision" && revisionProbeUrl === "" && capabilityKind === "ocr") {
    throw new Error('loadConfig: REVISION_PROBE_MODE="per_job" requires REVISION_PROBE_URL for the openai-vision upstream');
  }
  const revisionProbeMode: RevisionProbeMode = probeModeStr;

  // Custom-capability service config. SERVICE_URL is the operator's black box.
  const serviceUrl = capabilityKind === "custom" ? requireField(env, "SERVICE_URL") : (env.SERVICE_URL ?? "");
  const svcTimeoutStr = env.SERVICE_TIMEOUT_MS;
  let serviceTimeoutMs = 120_000;
  if (svcTimeoutStr !== undefined && svcTimeoutStr !== "") {
    if (!POS_INT_RE.test(svcTimeoutStr)) {
      throw new Error("loadConfig: SERVICE_TIMEOUT_MS must be a positive integer");
    }
    serviceTimeoutMs = Number(svcTimeoutStr);
  }
  const serviceAuthHeader = env.SERVICE_AUTH_HEADER ?? "";
  const serviceContentType = env.SERVICE_CONTENT_TYPE ?? "application/json";

  // ADVERT_MAX_PROCESSING_MS — the advertised SLA. Required for the custom
  // kind (the boot guard in createApp compares SERVICE_TIMEOUT_MS against it
  // and refuses to start when the service budget cannot nest inside the SLA).
  // Parsed and validated ONLY when capabilityKind="custom" — other kinds
  // never read this var before "custom" existed, so a stray/garbage value
  // left in a shared .env must not break their boot. 0 = not declared.
  let advertMaxProcessingMs = 0;
  if (capabilityKind === "custom") {
    const advertMaxProcessingMsStr = requireField(env, "ADVERT_MAX_PROCESSING_MS");
    if (!POS_INT_RE.test(advertMaxProcessingMsStr)) {
      throw new Error("loadConfig: ADVERT_MAX_PROCESSING_MS must be a positive integer");
    }
    advertMaxProcessingMs = Number(advertMaxProcessingMsStr);
  }

  const piperTimeoutStr = env.PIPER_TIMEOUT_MS;
  let piperTimeoutMs = 120_000;
  if (piperTimeoutStr !== undefined && piperTimeoutStr !== "") {
    if (!POS_INT_RE.test(piperTimeoutStr)) {
      throw new Error("loadConfig: PIPER_TIMEOUT_MS must be a positive integer");
    }
    piperTimeoutMs = Number(piperTimeoutStr);
  }

  // LIVE_CHAIN: only the literal "1" opts in to live-chain mode. Any other
  // value (including "true", "yes", "TRUE", "", undefined) keeps the supplier
  // in safe read-only mode. Real submissions require explicit opt-in.
  const liveChain = env.LIVE_CHAIN === "1";

  // WALLET_HEALTH_INTERVAL_MS accepts any non-negative integer; "0" disables.
  const whIntervalStr = env.WALLET_HEALTH_INTERVAL_MS;
  let walletHealthIntervalMs = 600_000;
  if (whIntervalStr !== undefined && whIntervalStr !== "") {
    if (!NON_NEG_INT_RE.test(whIntervalStr)) {
      throw new Error("loadConfig: WALLET_HEALTH_INTERVAL_MS must be a non-negative integer");
    }
    walletHealthIntervalMs = Number(whIntervalStr);
  }

  return {
    supplierPrivKeyHex,
    ogmiosUrl,
    ollamaUrl,
    openaiBaseUrl,
    openaiApiKey,
    openaiReasoningDisabled,
    openaiMaxTokens,
    openaiSessionPassthrough,
    openaiModelOverride,
    piperUrl,
    advertRef,
    networkId,
    port,
    ollamaTimeoutMs,
    openaiTimeoutMs,
    piperTimeoutMs,
    capabilityKind,
    llmBackend,
    chatIdleTimeoutMs,
    maxChatSessions,
    chatSettleMode,
    ocrUpstream,
    datalabApiKey,
    datalabBaseUrl,
    datalabMode,
    datalabTimeoutMs,
    ocrPromptOverride,
    hfModelRevision,
    revisionProbeUrl,
    revisionProbeMode,
    serviceUrl,
    serviceTimeoutMs,
    serviceAuthHeader,
    serviceContentType,
    advertMaxProcessingMs,
    liveChain,
    walletHealthIntervalMs,
  };
}
