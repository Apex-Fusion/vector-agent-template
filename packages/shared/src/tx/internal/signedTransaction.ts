import { CML } from "@lucid-evolution/lucid";
import type { OutputReference } from "../../chain/ChainProvider.js";
import { sha256Hex } from "./testTxBody.js";

export interface SignedTransactionInfo {
  txHash: string;
  validUntilSlot: number | null;
  outputIndexes: number[];
}

export interface SignedTransactionFinancials {
  feeLovelace: bigint;
  inputs: OutputReference[];
  outputs: { address: string; lovelace: bigint; datumHex?: string }[];
  collateralInputs: OutputReference[];
  /** Null means the body does not declare a total; inspect collateral inputs. */
  totalCollateralLovelace: bigint | null;
}

interface SyntheticTransactionBody {
  type: string;
  inputs: unknown[];
  outputs: unknown[];
  validityRange?: {
    upperBoundMs?: unknown;
  };
}

function safeSlot(value: bigint): number {
  const slot = Number(value);
  if (!Number.isSafeInteger(slot) || slot < 0) {
    throw new Error(`signed transaction has an invalid upper validity slot: ${value.toString()}`);
  }
  return slot;
}

function decodeSyntheticTransaction(txCborHex: string): SyntheticTransactionBody | null {
  if (!/^[0-9a-fA-F]+$/.test(txCborHex) || txCborHex.length < 10 || txCborHex.length % 2 !== 0) {
    return null;
  }

  const jsonByteLength = Number.parseInt(txCborHex.slice(0, 8), 16);
  if (!Number.isSafeInteger(jsonByteLength) || jsonByteLength <= 0) return null;
  const jsonEnd = 8 + jsonByteLength * 2;
  if (jsonEnd > txCborHex.length) return null;

  let parsed: SyntheticTransactionBody;
  try {
    const json = Buffer.from(txCborHex.slice(8, jsonEnd), "hex").toString("utf8");
    if (!json.startsWith("{")) return null;
    parsed = JSON.parse(json) as SyntheticTransactionBody;
  } catch {
    return null;
  }

  if (typeof parsed.type !== "string" || !Array.isArray(parsed.inputs) || !Array.isArray(parsed.outputs)) {
    return null;
  }

  return parsed;
}

function inspectSyntheticTransaction(txCborHex: string): SignedTransactionInfo | null {
  const parsed = decodeSyntheticTransaction(txCborHex);
  if (parsed === null) return null;
  const upperBoundMs = parsed.validityRange?.upperBoundMs;
  let validUntilSlot: number | null = null;
  if (upperBoundMs !== undefined && upperBoundMs !== null) {
    if (typeof upperBoundMs !== "number" || !Number.isFinite(upperBoundMs) || upperBoundMs < 0) {
      throw new Error("synthetic signed transaction has an invalid upper validity bound");
    }
    validUntilSlot = Math.floor(upperBoundMs / 1_000);
  }

  return {
    txHash: sha256Hex(txCborHex),
    validUntilSlot,
    outputIndexes: parsed.outputs.map((_output, index) => index),
  };
}

/** Inspect an already-signed transaction without changing it. */
export function inspectSignedTransaction(txCborHex: string): SignedTransactionInfo {
  const synthetic = inspectSyntheticTransaction(txCborHex);
  if (synthetic !== null) return synthetic;

  let transaction: InstanceType<typeof CML.Transaction> | undefined;
  let body: InstanceType<typeof CML.TransactionBody> | undefined;
  let hash: InstanceType<typeof CML.TransactionHash> | undefined;
  let outputs: InstanceType<typeof CML.TransactionOutputList> | undefined;
  try {
    transaction = CML.Transaction.from_cbor_hex(txCborHex);
    body = transaction.body();
    hash = CML.hash_transaction(body);
    outputs = body.outputs();
    const ttl = body.ttl();
    return {
      txHash: hash.to_hex().toLowerCase(),
      validUntilSlot: ttl === undefined ? null : safeSlot(ttl),
      outputIndexes: Array.from({ length: outputs.len() }, (_unused, index) => index),
    };
  } catch (error) {
    throw new Error(
      `cannot inspect signed transaction: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    outputs?.free();
    hash?.free();
    body?.free();
    transaction?.free();
  }
}

function syntheticInputRefs(value: unknown): OutputReference[] {
  if (!Array.isArray(value)) throw new Error("synthetic transaction inputs must be an array");
  return value.map((entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("synthetic transaction input must be an output reference");
    }
    const ref = entry as Record<string, unknown>;
    if (
      typeof ref.txHash !== "string" || !/^[0-9a-fA-F]{64}$/.test(ref.txHash) ||
      typeof ref.index !== "number" || !Number.isSafeInteger(ref.index) || ref.index < 0
    ) {
      throw new Error("synthetic transaction has an invalid input reference");
    }
    return { txHash: ref.txHash.toLowerCase(), index: ref.index };
  });
}

function syntheticOutputs(value: unknown): SignedTransactionFinancials["outputs"] {
  if (!Array.isArray(value)) throw new Error("synthetic transaction outputs must be an array");
  return value.map((entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("synthetic transaction output must be an object");
    }
    const row = entry as Record<string, unknown>;
    if (
      typeof row.address !== "string" || row.address.length === 0 ||
      typeof row.lovelace !== "string" || !/^(?:0|[1-9][0-9]*)n$/.test(row.lovelace)
    ) {
      throw new Error("synthetic transaction has an invalid output value");
    }
    const output: SignedTransactionFinancials["outputs"][number] = {
      address: row.address,
      lovelace: BigInt(row.lovelace.slice(0, -1)),
    };
    if (row.datumHex !== undefined && row.datumHex !== null) {
      if (typeof row.datumHex !== "string" || !/^(?:[0-9a-fA-F]{2})+$/.test(row.datumHex)) {
        throw new Error("synthetic transaction has an invalid inline datum");
      }
      output.datumHex = row.datumHex.toLowerCase();
    }
    return output;
  });
}

function liveInputRefs(list: InstanceType<typeof CML.TransactionInputList>): OutputReference[] {
  const refs: OutputReference[] = new Array(list.len());
  for (let i = 0; i < refs.length; i++) {
    const input = list.get(i);
    let hash: InstanceType<typeof CML.TransactionHash> | undefined;
    try {
      hash = input.transaction_id();
      const index = Number(input.index());
      if (!Number.isSafeInteger(index) || index < 0) {
        throw new Error("signed transaction has an invalid input index");
      }
      refs[i] = { txHash: hash.to_hex().toLowerCase(), index };
    } finally {
      hash?.free();
      input.free();
    }
  }
  return refs;
}

/** Read exact signed amounts before broadcast, while input values remain queryable. */
export function inspectSignedTransactionFinancials(txCborHex: string): SignedTransactionFinancials {
  const synthetic = decodeSyntheticTransaction(txCborHex);
  if (synthetic !== null) {
    // The repository's explicit MockChainProvider format has no fees or collateral.
    return {
      feeLovelace: 0n,
      inputs: syntheticInputRefs(synthetic.inputs),
      outputs: syntheticOutputs(synthetic.outputs),
      collateralInputs: [],
      totalCollateralLovelace: null,
    };
  }

  let transaction: InstanceType<typeof CML.Transaction> | undefined;
  let body: InstanceType<typeof CML.TransactionBody> | undefined;
  let inputs: InstanceType<typeof CML.TransactionInputList> | undefined;
  let outputs: InstanceType<typeof CML.TransactionOutputList> | undefined;
  let collateral: InstanceType<typeof CML.TransactionInputList> | undefined;
  try {
    transaction = CML.Transaction.from_cbor_hex(txCborHex);
    body = transaction.body();
    inputs = body.inputs();
    outputs = body.outputs();
    collateral = body.collateral_inputs();
    const values: SignedTransactionFinancials["outputs"] = new Array(outputs.len());
    for (let i = 0; i < values.length; i++) {
      const output = outputs.get(i);
      let address: InstanceType<typeof CML.Address> | undefined;
      let amount: InstanceType<typeof CML.Value> | undefined;
      let datum: InstanceType<typeof CML.DatumOption> | undefined;
      let inline: InstanceType<typeof CML.PlutusData> | undefined;
      try {
        address = output.address();
        amount = output.amount();
        datum = output.datum();
        inline = datum?.as_datum();
        const value: SignedTransactionFinancials["outputs"][number] = {
          address: address.to_bech32(),
          lovelace: amount.coin(),
        };
        if (inline !== undefined) value.datumHex = inline.to_cbor_hex();
        values[i] = value;
      } finally {
        inline?.free();
        datum?.free();
        amount?.free();
        address?.free();
        output.free();
      }
    }
    return {
      feeLovelace: body.fee(),
      inputs: liveInputRefs(inputs),
      outputs: values,
      collateralInputs: collateral === undefined ? [] : liveInputRefs(collateral),
      totalCollateralLovelace: body.total_collateral() ?? null,
    };
  } catch (error) {
    throw new Error(
      `cannot inspect signed transaction finances: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    collateral?.free();
    outputs?.free();
    inputs?.free();
    body?.free();
    transaction?.free();
  }
}
