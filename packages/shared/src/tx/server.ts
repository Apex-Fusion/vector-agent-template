/**
 * tx/server.ts — server-only re-exports.
 *
 * These bind the lucid-evolution + CML WASM dep graph at import time, so
 * they MUST NOT be imported from anything that gets bundled by Vite (i.e.
 * the buyer UI). The buyer SDK uses /* @vite-ignore *\/ dynamic imports
 * to reach the live-CBOR builders for the same reason.
 *
 * Consumers: supplier CLIs and Node-only tx tooling.
 */

export { loadEscrowScript, loadAdvertScript } from "./internal/liveCbor.js";
export { pkhToEnterpriseAddress } from "./internal/pkhAddress.js";
export type {
  LivePublishRefScriptsParams,
  PublishRefScriptsBuildResult,
} from "./internal/publishReferenceScripts.js";
export { buildLiveTxForPublishReferenceScripts } from "./internal/publishReferenceScripts.js";

// ── Wallet consolidate (one-shot operational tx; live-only) ─────────────
export type {
  ConsolidateWalletParams,
  ConsolidateWalletBuildResult,
} from "./wallet/consolidateWallet.js";
export { buildConsolidateWalletTx } from "./wallet/consolidateWallet.js";
export type {
  ConsolidateReason,
  PlannedConsolidate,
  UtxoLike,
} from "./wallet/planConsolidate.js";
export {
  DEFAULT_COLLATERAL_LOVELACE,
  DEFAULT_FEE_RESERVE,
  planConsolidate,
} from "./wallet/planConsolidate.js";
export type {
  ConsolidateWalletFlowParams,
  ConsolidateWalletFlowResult,
} from "./wallet/runConsolidateWallet.js";
export { runConsolidateWallet } from "./wallet/runConsolidateWallet.js";

// ── Wallet withdraw (custodial exit; live-only) ─────────────────────────
export type {
  WithdrawWalletParams,
  WithdrawWalletBuildResult,
} from "./wallet/withdrawWallet.js";
export { buildWithdrawTx } from "./wallet/withdrawWallet.js";
