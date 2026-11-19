/**
 * The template's single integration seam. Implement Executor to plug any
 * black-box service into the marketplace runtime. The default implementation
 * (httpCallout) forwards the payload to SERVICE_URL over HTTP.
 */

/**
 * What the runtime knows about the escrow of a job, read from the chain. The
 * runtime builds it. A buyer cannot set any part of it.
 */
export interface JobContext {
  /** The escrow that the buyer posted: "<64 hex>#<index>", in lower case. */
  escrowRef: string;
  /** The advert that the escrow names: "<64 hex>#<index>". */
  advertRef: string;
  /** The model text of the advert. */
  advertModel: string;
  /** The key hash of the buyer: 56 hex characters. */
  buyerPkh: string;
  /** The payment of the escrow in lovelace, as a decimal string. */
  paymentLovelace: string;
  /** The deliver-by time of the escrow, in POSIX milliseconds. */
  deliverByMs: number;
}

export interface ExecutorJob {
  capabilityId: string;
  /** Opaque request string (JSON by convention). Hashed into the escrow/receipt. */
  requestPayload: string;
  /** Remaining time budget in ms. Implementations must not exceed it. */
  deadlineMs: number;
  /** Escrow reference, for logging/correlation only. */
  jobRef: string;
  /** The escrow, the advert, the buyer, the payment and the deadline of the job. */
  context: JobContext;
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
