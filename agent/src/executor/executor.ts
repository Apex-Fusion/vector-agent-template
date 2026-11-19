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

/** What the runtime asks of the service before it claims: the request and the context of the job. */
export interface PrecheckJob {
  capabilityId: string;
  /** The request string, the same bytes that the job call sends later. */
  requestPayload: string;
  /** Escrow reference, for logging/correlation only. */
  jobRef: string;
  context: JobContext;
}

/**
 * The answer of the service to the check before the Claim. A refusal has an
 * HTTP error status (400 to 599), a code and a text. The runtime gives all
 * three to the buyer.
 */
export type PrecheckResult =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string };

export interface Executor {
  execute(job: ExecutorJob): Promise<ExecutorResult>;
  /**
   * Optional. The runtime calls it before the Claim. A refusal leaves the
   * escrow Open: the runtime builds no Claim. Without this method there is no
   * check, and the runtime claims as before.
   */
  precheck?(job: PrecheckJob): Promise<PrecheckResult>;
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
