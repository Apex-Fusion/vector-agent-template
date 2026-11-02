/**
 * Builds and submits the live wallet transaction that anchors one Surplus sale
 * Merkle batch. The caller remains responsible for awaiting confirmation.
 */

import type { LiveOgmiosProvider } from "../../chain/LiveOgmiosProvider.js";
import { OgmiosLucidProvider } from "../../chain/OgmiosLucidProvider.js";
import { createLucidContext } from "../internal/lucidContext.js";
import type { BuildResult, WalletKey } from "../types.js";
import { TxConstructionError } from "../types.js";

export const SURPLUS_SALE_PROOF_METADATA_LABEL = 674;
export const SURPLUS_SALE_PROOF_PROTOCOL = "surplus-sale-proof-v1";
export const MAX_TRANSACTION_METADATA_TEXT_BYTES = 64;

export interface SurplusSaleProofAnchorMetadata {
  p: typeof SURPLUS_SALE_PROOF_PROTOCOL;
  root: string;
  count: number;
  first: string;
  last: string;
}

export interface AnchorMetadataParams {
  chain: LiveOgmiosProvider;
  walletKey: WalletKey;
  metadata: SurplusSaleProofAnchorMetadata;
}

const ROOT_HEX_RE = /^[0-9a-f]{64}$/;
const PRINTABLE_ASCII_RE = /^[\x20-\x7e]+$/;
const METADATA_KEYS = ["p", "root", "count", "first", "last"] as const;
const textEncoder = new TextEncoder();

function metadataTextFits(value: string): boolean {
  return textEncoder.encode(value).byteLength <= MAX_TRANSACTION_METADATA_TEXT_BYTES;
}

function validSaleId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    PRINTABLE_ASCII_RE.test(value) &&
    metadataTextFits(value)
  );
}

/** Validate the exact label-674 payload before Lucid or Ogmios is initialized. */
export function validateSurplusSaleProofAnchorMetadata(
  value: unknown,
): asserts value is SurplusSaleProofAnchorMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TxConstructionError(
      "anchor_metadata_invalid",
      "Surplus sale proof metadata must be an object",
    );
  }

  const metadata = value as Record<string, unknown>;
  const keys = Object.keys(metadata);
  if (
    keys.length !== METADATA_KEYS.length ||
    METADATA_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(metadata, key))
  ) {
    throw new TxConstructionError(
      "anchor_metadata_invalid",
      "Surplus sale proof metadata must contain only p, root, count, first, and last",
    );
  }

  if (metadata.p !== SURPLUS_SALE_PROOF_PROTOCOL) {
    throw new TxConstructionError(
      "anchor_metadata_invalid",
      `metadata protocol must be ${SURPLUS_SALE_PROOF_PROTOCOL}`,
    );
  }
  if (!metadataTextFits(SURPLUS_SALE_PROOF_PROTOCOL)) {
    throw new TxConstructionError(
      "anchor_metadata_oversized",
      "metadata protocol exceeds the 64-byte transaction metadata text limit",
    );
  }
  if (typeof metadata.root !== "string" || !ROOT_HEX_RE.test(metadata.root)) {
    throw new TxConstructionError(
      "anchor_metadata_invalid",
      "metadata root must be 64 lowercase hexadecimal characters",
    );
  }
  if (!metadataTextFits(metadata.root)) {
    throw new TxConstructionError(
      "anchor_metadata_oversized",
      "metadata root exceeds the 64-byte transaction metadata text limit",
    );
  }
  if (
    typeof metadata.count !== "number" ||
    !Number.isSafeInteger(metadata.count) ||
    metadata.count <= 0
  ) {
    throw new TxConstructionError(
      "anchor_metadata_invalid",
      "metadata count must be a positive safe integer",
    );
  }

  for (const field of ["first", "last"] as const) {
    const id = metadata[field];
    if (!validSaleId(id)) {
      const oversized =
        typeof id === "string" &&
        textEncoder.encode(id).byteLength > MAX_TRANSACTION_METADATA_TEXT_BYTES;
      throw new TxConstructionError(
        oversized ? "anchor_metadata_oversized" : "anchor_metadata_invalid",
        `metadata ${field} must be a non-empty printable ASCII sale ID of at most 64 bytes`,
      );
    }
  }
}

export async function buildAnchorMetadataTx(
  params: AnchorMetadataParams,
): Promise<BuildResult> {
  const { chain, walletKey, metadata } = params;
  validateSurplusSaleProofAnchorMetadata(metadata);

  const provider = new OgmiosLucidProvider({
    ogmiosUrl: chain.url,
    fetch: chain.fetchImpl,
  });
  const { lucid } = await createLucidContext(
    provider,
    walletKey,
    { networkId: 1, systemStartUnix: 0, slotLengthMs: 1000 },
    { usePresetProtocolParameters: true },
  );
  const realWalletUtxos = await lucid.wallet().getUtxos();
  const anchorMetadata = {
    p: metadata.p,
    root: metadata.root,
    count: metadata.count,
    first: metadata.first,
    last: metadata.last,
  };

  let signed;
  try {
    const txBuilder = lucid
      .newTx()
      .attachMetadata(SURPLUS_SALE_PROOF_METADATA_LABEL, anchorMetadata)
      .addSignerKey(walletKey.pubKeyHash)
      .setMinFee(500_000n);
    const completed = await txBuilder.complete({
      presetWalletInputs: realWalletUtxos,
      localUPLCEval: false,
    });
    signed = await completed.sign.withWallet().complete();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TxConstructionError("anchor_metadata_build_failed", message);
  }

  const txCborHex = signed.toCBOR();
  const expectedTxHash = signed.toHash();
  await chain.submitTx(txCborHex);

  return { txCborHex, expectedTxHash };
}
