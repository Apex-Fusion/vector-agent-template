import type { JsonObject, Paper2AgentManifest } from "./index.js";

/** ZIP duplicates path metadata; internal publication bundles remain limited to 64 MiB. */
export const PAPER2AGENT_MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;

export type PaperBuildState = "submitted" | "queued" | "building" | "verifying" | "awaiting_review" | "approved" | "rejected" | "failed" | "interrupted" | "cancelled";

export interface PaperSubmission {
  title: string;
  paper_url: string;
  /** Optional paper text supplied by the user, not model instructions. */
  paper_text?: string;
  /** Optional original PDF, bounded and decoded by the control service. */
  paper_pdf_base64?: string;
}

/**
 * A running build waits here while the wallet cannot pay for its next model
 * call. The build has no call, token, or time limit; the wallet is the limit.
 */
export interface PaperBuildPause {
  /** First refusal of the waiting model call. */
  since: number;
  /** Latest refusal. The build retries the same call about once a minute. */
  checked_at: number;
  message: string;
  required_lovelace: string | null;
  available_lovelace: string | null;
  deposit_address: string | null;
}

export interface PaperBuildEvent {
  seq: number;
  at: number;
  phase: string;
  message: string;
}

export interface PaperPackageFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface PaperAcceptanceCase {
  name: string;
  input: JsonObject;
  expected: JsonObject;
}

export interface PaperVerification {
  builder_run_id: string;
  verifier_run_id: string;
  paper_references: string[];
  checks: string[];
  test_source: string;
  test_stdout: string;
  cases: PaperAcceptanceCase[];
  model_calls: number;
  input_tokens: number | null;
  output_tokens: number | null;
}

export interface PaperPackageArtifact {
  sha256: string;
  manifest_hash: string;
  manifest: Paper2AgentManifest;
  /** SHA-256 of the exact submitted or fetched paper bytes. */
  paper_sha256: string;
  /** Exact base-image ID checked by both builder and publisher. */
  runtime_image: string;
  files: PaperPackageFile[];
  verification: PaperVerification;
}

export interface PaperReview {
  artifact_sha256: string;
  code_reviewed: boolean;
  license_reviewed: boolean;
  results_reviewed: boolean;
  notes: string;
  reviewed_at: number;
}

export interface PaperPublishTerms {
  target_id: string;
  artifact_sha256: string;
  price_lovelace: string;
  buyer_bond_lovelace: string;
  supplier_bond_lovelace: string;
}

export type PaperPublicationState = "prepared" | "publishing" | "confirmation_pending" | "published" | "failed";

export interface PaperPublication {
  id: string;
  state: PaperPublicationState;
  terms: PaperPublishTerms;
  supplier_pkh: string;
  deposit_address: string;
  endpoint_url: string;
  advert_ref: string | null;
  tx_hash: string | null;
  actual_debit_lovelace: string | null;
  error: string | null;
}

export interface PaperPublishTarget {
  id: string;
  label: string;
  network_id: 0 | 1;
  supplier_pkh: string;
  deposit_address: string;
  endpoint_url: string;
  available: boolean;
  live_chain: boolean;
}

/** Bounded list row; fetch /jobs/:id for the complete submission and artifact. */
export interface PaperBuildJobSummary {
  id: string;
  title: string;
  paper_url: string;
  state: PaperBuildState;
  publication_state: PaperPublicationState | null;
  paused: boolean;
  created_at: number;
  updated_at: number;
}

export interface PaperBuildJob {
  id: string;
  submission: Omit<PaperSubmission, "paper_pdf_base64">;
  state: PaperBuildState;
  attempt: number;
  created_at: number;
  updated_at: number;
  pause: PaperBuildPause | null;
  artifact: PaperPackageArtifact | null;
  review: PaperReview | null;
  publication: PaperPublication | null;
  error: string | null;
}

export interface PaperWorkflowReadiness {
  build_ready: boolean;
  build_error: string | null;
  publisher_ready: boolean;
  publisher_error: string | null;
}

export interface PaperPublishApproval {
  artifact_sha256: string;
  confirm: true;
  max_debit_lovelace: string;
}
