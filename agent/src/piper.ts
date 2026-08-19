/**
 * supplier/src/piper.ts — HTTP client for upstream PiperTTS (openedai-speech-min).
 *
 * Mirrors the contract of `ollama.ts`: a single async function that POSTs the
 * request, surfaces typed errors via a discriminated `reason`, and returns a
 * normalised result the runner can hash + commit on chain.
 *
 * callPiper({ piperUrl, text, voice, format, speed, timeoutMs })
 *   POST to ${piperUrl}/v1/audio/speech with OpenAI-shape body
 *     { model: "tts-1", input: text, voice, response_format: format, speed }
 *   Returns { audio: Uint8Array, contentType: string, wallclock_ms: number }
 *
 * Error reasons:
 *   "piper_failure"   — non-2xx HTTP, network error, unexpected fetch failure
 *   "piper_timeout"   — request exceeded timeoutMs (AbortError surfaced)
 *   "piper_malformed" — empty body or impossibly-small response (under 64 bytes
 *                       can't be a real audio frame; protects against an
 *                       upstream returning 200 with no body)
 *
 * Implementation notes:
 *   - Uses globalThis.fetch + AbortController so tests can vi.stubGlobal("fetch", ...).
 *   - Returns raw bytes (Uint8Array) — the runner hashes them directly via sha256
 *     to compute result_hash for the receipt. We do NOT base64 here; that's a
 *     job-payload concern (JSON-friendliness), not an upstream concern.
 *   - wallclock_ms is measured locally (Date.now bracketing the fetch) since
 *     openedai-speech-min doesn't return a timing field.
 */

export interface CallPiperParams {
  piperUrl: string;
  text: string;
  voice: string;
  /** mp3 | wav | opus | aac | flac — passed through verbatim as response_format */
  format: string;
  /** Playback speed multiplier; openedai-speech-min honours 0.5–1.5 */
  speed: number;
  timeoutMs: number;
}

export interface PiperResult {
  audio: Uint8Array;
  contentType: string;
  wallclock_ms: number;
}

export type PiperErrorReason = "piper_failure" | "piper_timeout" | "piper_malformed";

export class PiperError extends Error {
  public readonly reason: PiperErrorReason;
  constructor(reason: PiperErrorReason, message?: string) {
    super(message ?? reason);
    this.name = "PiperError";
    this.reason = reason;
  }
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === "AbortError") return true;
    if ((err as { code?: string }).code === "ABORT_ERR") return true;
  }
  return false;
}

/**
 * Minimum byte count we'll accept as "real" audio. PiperTTS-mp3 for a single
 * sentence runs ~5–10 KB; an mp3 frame header alone is 4 bytes. We pick a
 * conservative 64 to catch the "200 OK, body length 0" failure mode some
 * proxies produce on cold-start without flagging genuinely-short audio.
 */
const MIN_AUDIO_BYTES = 64;

export async function callPiper(params: CallPiperParams): Promise<PiperResult> {
  const { piperUrl, text, voice, format, speed, timeoutMs } = params;
  const url = `${piperUrl.replace(/\/+$/, "")}/v1/audio/speech`;
  const body = JSON.stringify({
    model: "tts-1",
    input: text,
    voice,
    response_format: format,
    speed,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    if (isAbortError(err)) {
      throw new PiperError("piper_timeout", `Piper request exceeded ${timeoutMs}ms`);
    }
    throw new PiperError(
      "piper_failure",
      `Piper fetch failed: ${(err as Error)?.message ?? String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      /* body unavailable */
    }
    throw new PiperError(
      "piper_failure",
      `Piper returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }

  let audio: Uint8Array;
  try {
    const buf = await response.arrayBuffer();
    audio = new Uint8Array(buf);
  } catch (err) {
    throw new PiperError(
      "piper_malformed",
      `Piper response body was unreadable: ${(err as Error)?.message ?? String(err)}`,
    );
  }

  if (audio.byteLength < MIN_AUDIO_BYTES) {
    throw new PiperError(
      "piper_malformed",
      `Piper response too small to be audio: ${audio.byteLength} bytes`,
    );
  }

  const wallclock_ms = Date.now() - startedAt;
  const contentType = response.headers.get("content-type") ?? `audio/${format}`;

  return { audio, contentType, wallclock_ms };
}
