/**
 * The template's single integration seam. Implement Executor to plug any
 * black-box service into the marketplace runtime. The default implementation
 * (httpCallout) forwards the payload to SERVICE_URL over HTTP.
 */
export interface ExecutorJob {
  capabilityId: string;
  /** Opaque request string (JSON by convention). Hashed into the escrow/receipt. */
  requestPayload: string;
  /** Remaining time budget in ms. Implementations must not exceed it. */
  deadlineMs: number;
  /** Escrow reference, for logging/correlation only. */
  jobRef: string;
}

export interface ExecutorResult {
  /** Opaque output string (JSON by convention). Hashed into the receipt. */
  outputPayload: string;
  meta?: Record<string, unknown>;
}

export interface Executor {
  execute(job: ExecutorJob): Promise<ExecutorResult>;
}

export class ExecutorError extends Error {
  constructor(
    public readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "ExecutorError";
  }
}
