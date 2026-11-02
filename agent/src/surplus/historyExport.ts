/**
 * historyExport.ts — loads the Surplus support export
 * (request_id, settled_at, model, input_tokens, output_tokens,
 * seller_earned_usd, settlement_status, settlement_type, tx_hash) and maps the
 * settled rows onto the publisher's sale shape.
 *
 * The export carries less detail than the live API. The mapping records what
 * the export proves and nothing more:
 * - `createdAt` uses the export's `settled_at` timestamp,
 * - `cacheReadTokens` and both effective prices are zero (absent from the export),
 * - `offerId` comes from configuration because the export omits it.
 * Rows that are not settled (`settlement_status` !== "confirmed") are skipped;
 * they surface later through the live window or a newer export.
 */

import { readFile } from "node:fs/promises";
import type { SurplusSale } from "./client.js";

const EXPECTED_HEADER = [
  "request_id",
  "settled_at",
  "model",
  "input_tokens",
  "output_tokens",
  "seller_earned_usd",
  "settlement_status",
  "settlement_type",
  "tx_hash",
] as const;

const BASE_TX_RE = /^0x[0-9a-fA-F]{64}$/;
const TOKENS_RE = /^(?:0|[1-9]\d*)$/;
const USD_RE = /^(?:0|[1-9]\d*)(?:\.(\d{1,6}))?$/;

export interface HistoricalSalesExport {
  sales: SurplusSale[];
  settledWithoutTx: number;
  skippedUnsettled: number;
}

export async function loadHistoricalSalesCsv(
  path: string,
  offerId: string,
): Promise<HistoricalSalesExport> {
  if (offerId.trim() === "") {
    throw new Error("The historical export needs a non-empty offer id");
  }
  const rows = parseCsv(await readFile(path, "utf8"));
  const header = rows.shift();
  if (
    header === undefined ||
    header.length !== EXPECTED_HEADER.length ||
    EXPECTED_HEADER.some((name, index) => header[index] !== name)
  ) {
    throw new Error(
      `Surplus export header must be exactly: ${EXPECTED_HEADER.join(",")}`,
    );
  }

  const result: HistoricalSalesExport = {
    sales: [],
    settledWithoutTx: 0,
    skippedUnsettled: 0,
  };
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const label = `Surplus export row ${index + 2}`;
    if (row.length !== EXPECTED_HEADER.length) {
      throw new Error(`${label} has ${row.length} fields, expected 9`);
    }
    const [
      requestId,
      settledAt,
      model,
      inputTokens,
      outputTokens,
      earnedUsd,
      settlementStatus,
      ,
      txHash,
    ] = row;

    if (requestId === "") throw new Error(`${label} is missing request_id`);
    if (seen.has(requestId)) {
      throw new Error(`${label} repeats request_id ${requestId}`);
    }
    seen.add(requestId);
    if (settlementStatus !== "confirmed") {
      result.skippedUnsettled += 1;
      continue;
    }

    const createdAtMs = Date.parse(settledAt);
    if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
      throw new Error(`${label} has an invalid settled_at`);
    }
    const transactionHash = txHash === "" ? null : normalizeBaseTx(txHash, label);
    if (transactionHash === null) result.settledWithoutTx += 1;

    result.sales.push({
      id: requestId,
      model: nonEmpty(model, `${label} model`),
      offerId,
      settlementStatus,
      createdAt: new Date(createdAtMs).toISOString(),
      createdAtMs,
      sellerCostMicroUsd: usdToMicro(earnedUsd, `${label} seller_earned_usd`),
      inputTokens: tokens(inputTokens, `${label} input_tokens`),
      outputTokens: tokens(outputTokens, `${label} output_tokens`),
      cacheReadTokens: 0,
      effectiveInputUsdPer1m: 0,
      effectiveOutputUsdPer1m: 0,
      transactionHash,
    });
  }
  return result;
}

function normalizeBaseTx(value: string, label: string): string {
  if (!BASE_TX_RE.test(value)) {
    throw new Error(`${label} has an invalid tx_hash`);
  }
  return value.toLowerCase();
}

function nonEmpty(value: string, label: string): string {
  if (value.trim() === "") throw new Error(`${label} must not be empty`);
  return value;
}

function tokens(value: string, label: string): number {
  if (!TOKENS_RE.test(value)) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} exceeds the safe integer range`);
  }
  return parsed;
}

/** Exact decimal → micro-USD integer without float rounding. */
function usdToMicro(value: string, label: string): number {
  const match = USD_RE.exec(value);
  if (match === null) {
    throw new Error(`${label} must be a non-negative USD decimal with at most 6 places`);
  }
  const whole = Number(value.split(".")[0]);
  const fraction = Number((match[1] ?? "").padEnd(6, "0"));
  const micro = whole * 1_000_000 + fraction;
  if (!Number.isSafeInteger(micro)) {
    throw new Error(`${label} exceeds the safe integer range`);
  }
  return micro;
}

/** Minimal RFC-4180 parser: quoted fields, escaped quotes, CRLF or LF rows. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let index = 0;

  const pushField = (): void => {
    row.push(field);
    field = "";
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (index < text.length) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      if (field !== "") throw new Error(`Unexpected quote at offset ${index}`);
      quoted = true;
      index += 1;
      continue;
    }
    if (char === ",") {
      pushField();
      index += 1;
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      pushRow();
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }
  if (quoted) throw new Error("Unterminated quoted field");
  if (field !== "" || row.length > 0) pushRow();
  return rows.filter((entry) => !(entry.length === 1 && entry[0] === ""));
}
