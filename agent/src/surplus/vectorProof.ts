import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { SurplusSale } from "./client.js";

export const SURPLUS_SALE_PROOF_PROTOCOL = "surplus-sale-proof-v1" as const;
export const SURPLUS_VECTOR_BATCH_SIZE = 1_000;

export type SurplusSaleProofInput = Pick<
  SurplusSale,
  | "id"
  | "offerId"
  | "model"
  | "createdAt"
  | "inputTokens"
  | "outputTokens"
  | "cacheReadTokens"
  | "sellerCostMicroUsd"
  | "effectiveInputUsdPer1m"
  | "effectiveOutputUsdPer1m"
>;

/** The property order is part of the versioned leaf encoding. */
export interface CanonicalSurplusSale {
  protocol: typeof SURPLUS_SALE_PROOF_PROTOCOL;
  saleId: string;
  offerId: string;
  model: string;
  createdAtEpochMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  sellerCostMicroUsd: number;
  effectiveInputUsdPer1m: string;
  effectiveOutputUsdPer1m: string;
}

export interface SurplusMerkleProof {
  saleHash: string;
  batchRoot: string;
  leafIndex: number;
  leafCount: number;
  siblings: string[];
}

export interface SurplusMerkleLeaf extends SurplusMerkleProof {
  sale: CanonicalSurplusSale;
}

export interface SurplusMerkleBatch {
  root: string;
  count: number;
  firstSaleId: string;
  lastSaleId: string;
  leaves: SurplusMerkleLeaf[];
}

export type SurplusVectorProofStatus = "pending" | "confirmed" | "failed";

export interface SurplusDashboardVectorProof {
  status: SurplusVectorProofStatus;
  saleHash: string;
  batchRoot: string | null;
  txHash: string | null;
  leafIndex: number | null;
  siblings: string[];
}

export interface SurplusPendingBatchLeaf {
  saleId: string;
  saleHash: string;
  leafIndex: number;
  siblings: string[];
}

export interface SurplusPendingBatchIntent {
  batchRoot: string;
  count: number;
  firstSaleId: string;
  lastSaleId: string;
  createdAt: string;
  leaves: SurplusPendingBatchLeaf[];
}

export interface SurplusConfirmedBatch {
  batchRoot: string;
  count: number;
  firstSaleId: string;
  lastSaleId: string;
  txHash: string;
  confirmedAt: string;
}

export type SurplusBatchFailureStage = "build" | "submit" | "confirm";

export interface SurplusFailedBatchAttempt {
  batchRoot: string;
  count: number;
  firstSaleId: string;
  lastSaleId: string;
  stage: SurplusBatchFailureStage;
  failedAt: string;
}

interface LedgerSale {
  sale: CanonicalSurplusSale;
  vectorProof: SurplusDashboardVectorProof;
}

interface SurplusVectorProofLedgerState {
  version: 1;
  sales: LedgerSale[];
  pendingBatch: SurplusPendingBatchIntent | null;
  confirmedBatches: SurplusConfirmedBatch[];
  failedAttempts: SurplusFailedBatchAttempt[];
}

export interface OpenSurplusVectorProofLedgerOptions {
  now?: () => number;
}

export function canonicalizeSurplusSale(
  sale: SurplusSaleProofInput,
): CanonicalSurplusSale {
  const saleId = saleIdString(sale.id, "Surplus sale id");
  const offerId = boundedString(sale.offerId, "Surplus sale offer id", 512);
  const model = boundedString(sale.model, "Surplus sale model", 512);
  if (sale.createdAt === null) {
    throw new Error(`Surplus sale ${saleId} has no creation time`);
  }
  const createdAtEpochMs = Date.parse(sale.createdAt);
  if (!Number.isSafeInteger(createdAtEpochMs) || createdAtEpochMs < 0) {
    throw new Error(`Surplus sale ${saleId} has an invalid creation time`);
  }

  return {
    protocol: SURPLUS_SALE_PROOF_PROTOCOL,
    saleId,
    offerId,
    model,
    createdAtEpochMs,
    inputTokens: nonNegativeSafeInteger(sale.inputTokens, "input tokens"),
    outputTokens: nonNegativeSafeInteger(sale.outputTokens, "output tokens"),
    cacheReadTokens: nonNegativeSafeInteger(
      sale.cacheReadTokens,
      "cache-read tokens",
    ),
    sellerCostMicroUsd: nonNegativeSafeInteger(
      sale.sellerCostMicroUsd,
      "seller cost",
    ),
    effectiveInputUsdPer1m: fixedSixDecimal(
      sale.effectiveInputUsdPer1m,
      "effective input price",
    ),
    effectiveOutputUsdPer1m: fixedSixDecimal(
      sale.effectiveOutputUsdPer1m,
      "effective output price",
    ),
  };
}

export function canonicalSurplusSaleJson(sale: CanonicalSurplusSale): string {
  return JSON.stringify(parseCanonicalSale(sale, "Canonical Surplus sale"));
}

export function hashCanonicalSurplusSale(sale: CanonicalSurplusSale): string {
  return createHash("sha256")
    .update(canonicalSurplusSaleJson(sale), "utf8")
    .digest("hex");
}

export function hashSurplusSale(sale: SurplusSaleProofInput): string {
  return hashCanonicalSurplusSale(canonicalizeSurplusSale(sale));
}

export function buildSurplusMerkleBatch(
  sales: readonly CanonicalSurplusSale[],
): SurplusMerkleBatch {
  if (sales.length === 0 || sales.length > SURPLUS_VECTOR_BATCH_SIZE) {
    throw new Error(
      `A Surplus proof batch must contain 1-${SURPLUS_VECTOR_BATCH_SIZE} sales`,
    );
  }

  const ordered = sales.map((sale) =>
    parseCanonicalSale(sale, "Canonical Surplus sale")
  ).sort((left, right) => compareSaleIds(left.saleId, right.saleId));
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1].saleId === ordered[index].saleId) {
      throw new Error(`Duplicate Surplus sale id: ${ordered[index].saleId}`);
    }
  }

  const hashes = ordered.map((sale) =>
    Buffer.from(hashCanonicalSurplusSale(sale), "hex")
  );
  const levels: Buffer[][] = [hashes];
  while (levels[levels.length - 1].length > 1) {
    const current = levels[levels.length - 1];
    const next: Buffer[] = [];
    for (let index = 0; index < current.length; index += 2) {
      const left = current[index];
      const right = current[index + 1] ?? left;
      next.push(hashPair(left, right));
    }
    levels.push(next);
  }

  const root = levels[levels.length - 1][0].toString("hex");
  const leaves = ordered.map((sale, leafIndex): SurplusMerkleLeaf => {
    const siblings: string[] = [];
    let index = leafIndex;
    for (let level = 0; level < levels.length - 1; level += 1) {
      const nodes = levels[level];
      const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
      siblings.push((nodes[siblingIndex] ?? nodes[index]).toString("hex"));
      index = Math.floor(index / 2);
    }
    return {
      sale,
      saleHash: hashes[leafIndex].toString("hex"),
      batchRoot: root,
      leafIndex,
      leafCount: ordered.length,
      siblings,
    };
  });

  return {
    root,
    count: ordered.length,
    firstSaleId: ordered[0].saleId,
    lastSaleId: ordered[ordered.length - 1].saleId,
    leaves,
  };
}

export function verifySurplusMerkleProof(
  sale: SurplusSaleProofInput | CanonicalSurplusSale,
  proof: SurplusMerkleProof,
): boolean {
  try {
    if (!isHash(proof.saleHash) || !isHash(proof.batchRoot)) return false;
    if (
      !Number.isSafeInteger(proof.leafCount) ||
      proof.leafCount < 1 ||
      proof.leafCount > SURPLUS_VECTOR_BATCH_SIZE ||
      !Number.isSafeInteger(proof.leafIndex) ||
      proof.leafIndex < 0 ||
      proof.leafIndex >= proof.leafCount ||
      proof.siblings.length !== merkleDepth(proof.leafCount) ||
      proof.siblings.some((sibling) => !isHash(sibling))
    ) return false;

    const canonical = isCanonicalSale(sale)
      ? parseCanonicalSale(sale, "Canonical Surplus sale")
      : canonicalizeSurplusSale(sale);
    const saleHash = hashCanonicalSurplusSale(canonical);
    if (saleHash !== proof.saleHash) return false;

    let hash: Buffer = Buffer.from(saleHash, "hex");
    let index = proof.leafIndex;
    let width = proof.leafCount;
    for (const siblingHex of proof.siblings) {
      const sibling = Buffer.from(siblingHex, "hex");
      if (index % 2 === 0) {
        if (index + 1 >= width && !hash.equals(sibling)) return false;
        hash = hashPair(hash, sibling);
      } else {
        hash = hashPair(sibling, hash);
      }
      index = Math.floor(index / 2);
      width = Math.ceil(width / 2);
    }
    return width === 1 && index === 0 && hash.toString("hex") === proof.batchRoot;
  } catch {
    return false;
  }
}

export class FileSurplusVectorProofLedger {
  private state: SurplusVectorProofLedgerState;
  private readonly now: () => number;

  private constructor(
    private readonly path: string,
    state: SurplusVectorProofLedgerState,
    options: OpenSurplusVectorProofLedgerOptions,
  ) {
    this.state = state;
    this.now = options.now ?? Date.now;
  }

  static async open(
    path: string,
    options: OpenSurplusVectorProofLedgerOptions = {},
  ): Promise<FileSurplusVectorProofLedger> {
    return new FileSurplusVectorProofLedger(
      path,
      await loadLedger(path),
      options,
    );
  }

  async ingestSales(
    sales: readonly SurplusSaleProofInput[],
  ): Promise<{ inserted: number; duplicates: number }> {
    const incoming = new Map<string, CanonicalSurplusSale>();
    let duplicates = 0;
    for (const input of sales) {
      const sale = canonicalizeSurplusSale(input);
      const prior = incoming.get(sale.saleId);
      if (prior !== undefined) {
        if (hashCanonicalSurplusSale(prior) !== hashCanonicalSurplusSale(sale)) {
          throw new Error(`Conflicting Surplus sale id: ${sale.saleId}`);
        }
        duplicates += 1;
      } else {
        incoming.set(sale.saleId, sale);
      }
    }

    const byId = new Map(this.state.sales.map((entry) => [entry.sale.saleId, entry]));
    const additions: LedgerSale[] = [];
    for (const sale of incoming.values()) {
      const existing = byId.get(sale.saleId);
      const saleHash = hashCanonicalSurplusSale(sale);
      if (existing !== undefined) {
        if (existing.vectorProof.saleHash !== saleHash) {
          throw new Error(`Conflicting Surplus sale id: ${sale.saleId}`);
        }
        duplicates += 1;
        continue;
      }
      additions.push({
        sale,
        vectorProof: {
          status: "pending",
          saleHash,
          batchRoot: null,
          txHash: null,
          leafIndex: null,
          siblings: [],
        },
      });
    }

    if (additions.length > 0) {
      const next = cloneState(this.state);
      next.sales.push(...additions);
      next.sales.sort((left, right) => compareSaleIds(
        left.sale.saleId,
        right.sale.saleId,
      ));
      await this.commit(next);
    }
    return { inserted: additions.length, duplicates };
  }

  selectUnprovedSales(
    limit = SURPLUS_VECTOR_BATCH_SIZE,
  ): CanonicalSurplusSale[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > SURPLUS_VECTOR_BATCH_SIZE) {
      throw new Error(
        `Surplus proof selection limit must be 1-${SURPLUS_VECTOR_BATCH_SIZE}`,
      );
    }
    if (this.state.pendingBatch !== null) {
      throw new Error("The pending Surplus proof batch must be resolved first");
    }
    return this.state.sales
      .filter((entry) => entry.vectorProof.status !== "confirmed")
      .slice(0, limit)
      .map((entry) => structuredClone(entry.sale));
  }

  async persistPendingBatch(
    saleIds: readonly string[],
  ): Promise<SurplusPendingBatchIntent> {
    if (this.state.pendingBatch !== null) {
      throw new Error("The pending Surplus proof batch must be resolved first");
    }
    if (saleIds.length === 0 || saleIds.length > SURPLUS_VECTOR_BATCH_SIZE) {
      throw new Error(
        `A Surplus proof batch must contain 1-${SURPLUS_VECTOR_BATCH_SIZE} sales`,
      );
    }

    const requested = new Set<string>();
    for (const value of saleIds) {
      const id = saleIdString(value, "Surplus sale id");
      if (requested.has(id)) throw new Error(`Duplicate Surplus sale id: ${id}`);
      requested.add(id);
    }
    const byId = new Map(this.state.sales.map((entry) => [entry.sale.saleId, entry]));
    const selected = [...requested].map((id) => {
      const entry = byId.get(id);
      if (entry === undefined) throw new Error(`Unknown Surplus sale id: ${id}`);
      if (entry.vectorProof.status === "confirmed") {
        throw new Error(`Surplus sale is already confirmed: ${id}`);
      }
      return entry.sale;
    });
    const batch = buildSurplusMerkleBatch(selected);
    const createdAt = timestamp(this.now(), "Current time");
    const intent: SurplusPendingBatchIntent = {
      batchRoot: batch.root,
      count: batch.count,
      firstSaleId: batch.firstSaleId,
      lastSaleId: batch.lastSaleId,
      createdAt,
      leaves: batch.leaves.map((leaf) => ({
        saleId: leaf.sale.saleId,
        saleHash: leaf.saleHash,
        leafIndex: leaf.leafIndex,
        siblings: [...leaf.siblings],
      })),
    };

    const proofs = new Map(intent.leaves.map((leaf) => [leaf.saleId, leaf]));
    const next = cloneState(this.state);
    next.pendingBatch = intent;
    for (const entry of next.sales) {
      const leaf = proofs.get(entry.sale.saleId);
      if (leaf === undefined) continue;
      entry.vectorProof = {
        status: "pending",
        saleHash: leaf.saleHash,
        batchRoot: intent.batchRoot,
        txHash: null,
        leafIndex: leaf.leafIndex,
        siblings: [...leaf.siblings],
      };
    }
    await this.commit(next);
    return structuredClone(intent);
  }

  async createPendingBatch(
    limit = SURPLUS_VECTOR_BATCH_SIZE,
  ): Promise<SurplusPendingBatchIntent | null> {
    const selected = this.selectUnprovedSales(limit);
    return selected.length === 0
      ? null
      : this.persistPendingBatch(selected.map((sale) => sale.saleId));
  }

  pendingBatchIntent(): SurplusPendingBatchIntent | null {
    return this.state.pendingBatch === null
      ? null
      : structuredClone(this.state.pendingBatch);
  }

  async confirmPendingBatch(
    batchRoot: string,
    txHash: string,
  ): Promise<SurplusConfirmedBatch> {
    const pending = this.requirePendingBatch(batchRoot);
    const normalizedTxHash = transactionHash(txHash);
    const confirmed: SurplusConfirmedBatch = {
      batchRoot: pending.batchRoot,
      count: pending.count,
      firstSaleId: pending.firstSaleId,
      lastSaleId: pending.lastSaleId,
      txHash: normalizedTxHash,
      confirmedAt: timestamp(this.now(), "Current time"),
    };
    const leaves = new Map(pending.leaves.map((leaf) => [leaf.saleId, leaf]));
    const next = cloneState(this.state);
    for (const entry of next.sales) {
      const leaf = leaves.get(entry.sale.saleId);
      if (leaf === undefined) continue;
      entry.vectorProof = {
        status: "confirmed",
        saleHash: leaf.saleHash,
        batchRoot: pending.batchRoot,
        txHash: normalizedTxHash,
        leafIndex: leaf.leafIndex,
        siblings: [...leaf.siblings],
      };
    }
    next.pendingBatch = null;
    next.confirmedBatches.push(confirmed);
    await this.commit(next);
    return structuredClone(confirmed);
  }

  async failPendingBatch(
    batchRoot: string,
    stage: SurplusBatchFailureStage,
  ): Promise<SurplusFailedBatchAttempt> {
    const pending = this.requirePendingBatch(batchRoot);
    if (stage !== "build" && stage !== "submit" && stage !== "confirm") {
      throw new Error("Invalid Surplus proof batch failure stage");
    }
    const failed: SurplusFailedBatchAttempt = {
      batchRoot: pending.batchRoot,
      count: pending.count,
      firstSaleId: pending.firstSaleId,
      lastSaleId: pending.lastSaleId,
      stage,
      failedAt: timestamp(this.now(), "Current time"),
    };
    const leaves = new Map(pending.leaves.map((leaf) => [leaf.saleId, leaf]));
    const next = cloneState(this.state);
    for (const entry of next.sales) {
      const leaf = leaves.get(entry.sale.saleId);
      if (leaf === undefined) continue;
      entry.vectorProof = {
        status: "failed",
        saleHash: leaf.saleHash,
        batchRoot: pending.batchRoot,
        txHash: null,
        leafIndex: leaf.leafIndex,
        siblings: [...leaf.siblings],
      };
    }
    next.pendingBatch = null;
    next.failedAttempts.push(failed);
    await this.commit(next);
    return structuredClone(failed);
  }

  dashboardProof(saleId: string): SurplusDashboardVectorProof | null {
    const entry = this.state.sales.find((candidate) =>
      candidate.sale.saleId === saleId
    );
    return entry === undefined ? null : structuredClone(entry.vectorProof);
  }

  confirmedBatchHistory(): SurplusConfirmedBatch[] {
    return structuredClone(this.state.confirmedBatches);
  }

  failedAttemptHistory(): SurplusFailedBatchAttempt[] {
    return structuredClone(this.state.failedAttempts);
  }

  private requirePendingBatch(batchRoot: string): SurplusPendingBatchIntent {
    if (!isHash(batchRoot)) throw new Error("Invalid Surplus proof batch root");
    const pending = this.state.pendingBatch;
    if (pending === null) throw new Error("There is no pending Surplus proof batch");
    if (pending.batchRoot !== batchRoot) {
      throw new Error("The Surplus proof batch root does not match the pending intent");
    }
    return pending;
  }

  private async commit(next: SurplusVectorProofLedgerState): Promise<void> {
    const parsed = parseLedger(next);
    await saveLedger(this.path, parsed);
    this.state = parsed;
  }
}


function compareSaleIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fixedSixDecimal(value: number, field: string): string {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Surplus sale ${field} must be a non-negative number`);
  }
  const fixed = value.toFixed(6);
  if (!FIXED_SIX_DECIMAL.test(fixed)) {
    throw new Error(`Surplus sale ${field} is outside the supported range`);
  }
  return fixed;
}

function nonNegativeSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Surplus sale ${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function boundedString(value: unknown, field: string, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new Error(`${field} must be a non-empty string of at most ${maximumBytes} bytes`);
  }
  return value;
}

function saleIdString(value: unknown, field: string): string {
  const id = boundedString(value, field, 64);
  if (!PRINTABLE_ASCII.test(id)) {
    throw new Error(`${field} must contain printable ASCII characters only`);
  }
  return id;
}

function timestamp(value: number, field: string): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be epoch milliseconds`);
  }
  return new Date(value).toISOString();
}

function transactionHash(value: unknown): string {
  if (typeof value !== "string" || !TX_HASH.test(value)) {
    throw new Error("Vector transaction hash must be 64 hexadecimal characters");
  }
  return value.toLowerCase();
}

function hashPair(left: Buffer, right: Buffer): Buffer {
  return createHash("sha256").update(left).update(right).digest();
}


function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}

function merkleDepth(count: number): number {
  let depth = 0;
  for (let width = count; width > 1; width = Math.ceil(width / 2)) depth += 1;
  return depth;
}

function isCanonicalSale(
  sale: SurplusSaleProofInput | CanonicalSurplusSale,
): sale is CanonicalSurplusSale {
  return "protocol" in sale;
}

function parseCanonicalSale(value: unknown, field: string): CanonicalSurplusSale {
  const sale = object(value, field);
  if (sale.protocol !== SURPLUS_SALE_PROOF_PROTOCOL) {
    throw new Error(`${field}.protocol is not supported`);
  }
  const effectiveInputUsdPer1m = decimalString(
    sale.effectiveInputUsdPer1m,
    `${field}.effectiveInputUsdPer1m`,
  );
  const effectiveOutputUsdPer1m = decimalString(
    sale.effectiveOutputUsdPer1m,
    `${field}.effectiveOutputUsdPer1m`,
  );
  return {
    protocol: SURPLUS_SALE_PROOF_PROTOCOL,
    saleId: saleIdString(sale.saleId, `${field}.saleId`),
    offerId: boundedString(sale.offerId, `${field}.offerId`, 512),
    model: boundedString(sale.model, `${field}.model`, 512),
    createdAtEpochMs: nonNegativeSafeInteger(
      sale.createdAtEpochMs,
      `${field}.createdAtEpochMs`,
    ),
    inputTokens: nonNegativeSafeInteger(sale.inputTokens, `${field}.inputTokens`),
    outputTokens: nonNegativeSafeInteger(sale.outputTokens, `${field}.outputTokens`),
    cacheReadTokens: nonNegativeSafeInteger(
      sale.cacheReadTokens,
      `${field}.cacheReadTokens`,
    ),
    sellerCostMicroUsd: nonNegativeSafeInteger(
      sale.sellerCostMicroUsd,
      `${field}.sellerCostMicroUsd`,
    ),
    effectiveInputUsdPer1m,
    effectiveOutputUsdPer1m,
  };
}

function decimalString(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length > 32 ||
    !FIXED_SIX_DECIMAL.test(value) ||
    !Number.isFinite(Number(value))
  ) throw new Error(`${field} must be fixed 6-decimal text`);
  return value;
}

async function loadLedger(path: string): Promise<SurplusVectorProofLedgerState> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return emptyLedger();
    throw error;
  }
  try {
    assertSecureOwner(await handle.stat(), false, "Surplus proof ledger file");
    let value: unknown;
    try {
      value = JSON.parse(await handle.readFile("utf8"));
    } catch {
      throw new Error("Surplus proof ledger file is not valid JSON");
    }
    return parseLedger(value);
  } finally {
    await handle.close();
  }
}

async function saveLedger(
  path: string,
  state: SurplusVectorProofLedgerState,
): Promise<void> {
  const directory = dirname(path);
  try {
    const info = await lstat(directory);
    assertOwnerAndType(info, true, "Surplus proof ledger directory");
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  let directoryInfo = await lstat(directory);
  assertOwnerAndType(directoryInfo, true, "Surplus proof ledger directory");
  await chmod(directory, 0o700);
  directoryInfo = await lstat(directory);
  assertSecureOwner(directoryInfo, true, "Surplus proof ledger directory");

  try {
    assertSecureOwner(await lstat(path), false, "Surplus proof ledger file");
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }

  const tempPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  const body = `${JSON.stringify(state)}\n`;
  let handle: FileHandle | null = null;
  try {
    handle = await open(
      tempPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tempPath, path);
    const directoryHandle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
    await unlink(tempPath).catch((error) => {
      if (!isNodeError(error, "ENOENT")) throw error;
    });
  }
}

function parseLedger(value: unknown): SurplusVectorProofLedgerState {
  const root = object(value, "Surplus proof ledger");
  if (root.version !== 1) throw new Error("Unsupported Surplus proof ledger version");
  if (!Array.isArray(root.sales)) throw new Error("Surplus proof ledger sales must be an array");
  if (!Array.isArray(root.confirmedBatches)) {
    throw new Error("Surplus proof ledger confirmedBatches must be an array");
  }
  if (!Array.isArray(root.failedAttempts)) {
    throw new Error("Surplus proof ledger failedAttempts must be an array");
  }

  const sales = root.sales.map(parseLedgerSale);
  sales.sort((left, right) => compareSaleIds(left.sale.saleId, right.sale.saleId));
  for (let index = 1; index < sales.length; index += 1) {
    if (sales[index - 1].sale.saleId === sales[index].sale.saleId) {
      throw new Error(`Duplicate Surplus sale id: ${sales[index].sale.saleId}`);
    }
  }
  const pendingBatch = root.pendingBatch === null
    ? null
    : parsePendingBatch(root.pendingBatch);
  const confirmedBatches = root.confirmedBatches.map(parseConfirmedBatch);
  const failedAttempts = root.failedAttempts.map(parseFailedAttempt);
  const state: SurplusVectorProofLedgerState = {
    version: 1,
    sales,
    pendingBatch,
    confirmedBatches,
    failedAttempts,
  };
  validateLedgerRelationships(state);
  return state;
}

function parseLedgerSale(value: unknown, index: number): LedgerSale {
  const entry = object(value, `Surplus proof ledger sale ${index}`);
  const sale = parseCanonicalSale(entry.sale, `Surplus proof ledger sale ${index}.sale`);
  const proof = object(entry.vectorProof, `Surplus proof ledger sale ${index}.vectorProof`);
  if (proof.status !== "pending" && proof.status !== "confirmed" && proof.status !== "failed") {
    throw new Error(`Surplus proof ledger sale ${index} has an invalid proof status`);
  }
  const siblings = hashArray(proof.siblings, `Surplus proof ledger sale ${index} siblings`);
  const batchRoot = proof.batchRoot === null
    ? null
    : requiredHash(proof.batchRoot, `Surplus proof ledger sale ${index} batchRoot`);
  const txHash = proof.txHash === null ? null : transactionHash(proof.txHash);
  const leafIndex = proof.leafIndex === null
    ? null
    : nonNegativeSafeInteger(proof.leafIndex, `Surplus proof ledger sale ${index} leafIndex`);
  const vectorProof: SurplusDashboardVectorProof = {
    status: proof.status,
    saleHash: requiredHash(proof.saleHash, `Surplus proof ledger sale ${index} saleHash`),
    batchRoot,
    txHash,
    leafIndex,
    siblings,
  };
  if (vectorProof.saleHash !== hashCanonicalSurplusSale(sale)) {
    throw new Error(`Surplus proof ledger sale ${index} hash does not match its sale`);
  }
  if (batchRoot === null) {
    if (proof.status !== "pending" || txHash !== null || leafIndex !== null || siblings.length !== 0) {
      throw new Error(`Surplus proof ledger sale ${index} has an incomplete proof`);
    }
  } else if (leafIndex === null) {
    throw new Error(`Surplus proof ledger sale ${index} has no leaf index`);
  }
  if (proof.status === "confirmed" ? txHash === null : txHash !== null) {
    throw new Error(`Surplus proof ledger sale ${index} has an invalid transaction hash`);
  }
  return { sale, vectorProof };
}

function parsePendingBatch(value: unknown): SurplusPendingBatchIntent {
  const batch = parseBatchSummary(value, "Surplus pending proof batch");
  const root = object(value, "Surplus pending proof batch");
  if (!Array.isArray(root.leaves)) {
    throw new Error("Surplus pending proof batch leaves must be an array");
  }
  const leaves = root.leaves.map((value, index): SurplusPendingBatchLeaf => {
    const leaf = object(value, `Surplus pending proof batch leaf ${index}`);
    return {
      saleId: saleIdString(leaf.saleId, `Surplus pending proof batch leaf ${index}.saleId`),
      saleHash: requiredHash(leaf.saleHash, `Surplus pending proof batch leaf ${index}.saleHash`),
      leafIndex: nonNegativeSafeInteger(
        leaf.leafIndex,
        `Surplus pending proof batch leaf ${index}.leafIndex`,
      ),
      siblings: hashArray(leaf.siblings, `Surplus pending proof batch leaf ${index}.siblings`),
    };
  });
  return {
    ...batch,
    createdAt: isoTimestamp(root.createdAt, "Surplus pending proof batch createdAt"),
    leaves,
  };
}

function parseConfirmedBatch(value: unknown): SurplusConfirmedBatch {
  const batch = parseBatchSummary(value, "Surplus confirmed proof batch");
  const root = object(value, "Surplus confirmed proof batch");
  return {
    ...batch,
    txHash: transactionHash(root.txHash),
    confirmedAt: isoTimestamp(root.confirmedAt, "Surplus confirmed proof batch confirmedAt"),
  };
}

function parseFailedAttempt(value: unknown): SurplusFailedBatchAttempt {
  const batch = parseBatchSummary(value, "Surplus failed proof batch");
  const root = object(value, "Surplus failed proof batch");
  if (root.stage !== "build" && root.stage !== "submit" && root.stage !== "confirm") {
    throw new Error("Surplus failed proof batch has an invalid stage");
  }
  return {
    ...batch,
    stage: root.stage,
    failedAt: isoTimestamp(root.failedAt, "Surplus failed proof batch failedAt"),
  };
}

function parseBatchSummary(
  value: unknown,
  field: string,
): Omit<SurplusConfirmedBatch, "txHash" | "confirmedAt"> {
  const batch = object(value, field);
  const count = nonNegativeSafeInteger(batch.count, `${field}.count`);
  if (count < 1 || count > SURPLUS_VECTOR_BATCH_SIZE) {
    throw new Error(`${field}.count must be 1-${SURPLUS_VECTOR_BATCH_SIZE}`);
  }
  return {
    batchRoot: requiredHash(batch.batchRoot, `${field}.batchRoot`),
    count,
    firstSaleId: saleIdString(batch.firstSaleId, `${field}.firstSaleId`),
    lastSaleId: saleIdString(batch.lastSaleId, `${field}.lastSaleId`),
  };
}

function validateLedgerRelationships(state: SurplusVectorProofLedgerState): void {
  const byId = new Map(state.sales.map((entry) => [entry.sale.saleId, entry]));
  const pendingIds = new Set<string>();
  if (state.pendingBatch !== null) {
    const pending = state.pendingBatch;
    if (pending.leaves.length !== pending.count) {
      throw new Error("Surplus pending proof batch leaf count does not match");
    }
    const ids = pending.leaves.map((leaf) => leaf.saleId);
    const sortedIds = [...ids].sort(compareSaleIds);
    if (new Set(ids).size !== ids.length || ids.some((id, index) => id !== sortedIds[index])) {
      throw new Error("Surplus pending proof batch leaves are not uniquely sorted");
    }
    if (ids[0] !== pending.firstSaleId || ids[ids.length - 1] !== pending.lastSaleId) {
      throw new Error("Surplus pending proof batch boundaries do not match its leaves");
    }
    for (let index = 0; index < pending.leaves.length; index += 1) {
      const leaf = pending.leaves[index];
      pendingIds.add(leaf.saleId);
      const entry = byId.get(leaf.saleId);
      if (entry === undefined) throw new Error(`Pending proof references unknown sale: ${leaf.saleId}`);
      if (
        leaf.leafIndex !== index ||
        entry.vectorProof.status !== "pending" ||
        entry.vectorProof.batchRoot !== pending.batchRoot ||
        entry.vectorProof.leafIndex !== index ||
        entry.vectorProof.saleHash !== leaf.saleHash ||
        !sameStrings(entry.vectorProof.siblings, leaf.siblings) ||
        !verifySurplusMerkleProof(entry.sale, {
          saleHash: leaf.saleHash,
          batchRoot: pending.batchRoot,
          leafIndex: index,
          leafCount: pending.count,
          siblings: leaf.siblings,
        })
      ) throw new Error(`Invalid pending proof for Surplus sale: ${leaf.saleId}`);
    }
  }
  for (const entry of state.sales) {
    if (
      entry.vectorProof.status === "pending" &&
      entry.vectorProof.batchRoot !== null &&
      !pendingIds.has(entry.sale.saleId)
    ) {
      throw new Error(`Orphaned pending proof for Surplus sale: ${entry.sale.saleId}`);
    }
  }

  const confirmedByRoot = new Map<string, SurplusConfirmedBatch>();
  for (const batch of state.confirmedBatches) {
    if (confirmedByRoot.has(batch.batchRoot)) {
      throw new Error(`Duplicate confirmed Surplus batch root: ${batch.batchRoot}`);
    }
    confirmedByRoot.set(batch.batchRoot, batch);
  }
  const confirmedSalesByRoot = new Map<string, LedgerSale[]>();
  for (const entry of state.sales) {
    const proof = entry.vectorProof;
    if (proof.status !== "confirmed") continue;
    const batch = confirmedByRoot.get(proof.batchRoot as string);
    if (
      batch === undefined ||
      proof.txHash !== batch.txHash ||
      proof.leafIndex === null ||
      !verifySurplusMerkleProof(entry.sale, {
        saleHash: proof.saleHash,
        batchRoot: batch.batchRoot,
        leafIndex: proof.leafIndex,
        leafCount: batch.count,
        siblings: proof.siblings,
      })
    ) throw new Error(`Invalid confirmed proof for Surplus sale: ${entry.sale.saleId}`);
    const batchSales = confirmedSalesByRoot.get(batch.batchRoot) ?? [];
    batchSales.push(entry);
    confirmedSalesByRoot.set(batch.batchRoot, batchSales);
  }
  for (const batch of state.confirmedBatches) {
    const batchSales = confirmedSalesByRoot.get(batch.batchRoot) ?? [];
    batchSales.sort((left, right) =>
      (left.vectorProof.leafIndex as number) - (right.vectorProof.leafIndex as number)
    );
    if (
      batchSales.length !== batch.count ||
      batchSales.some((entry, index) => entry.vectorProof.leafIndex !== index) ||
      batchSales[0]?.sale.saleId !== batch.firstSaleId ||
      batchSales[batchSales.length - 1]?.sale.saleId !== batch.lastSaleId
    ) throw new Error(`Confirmed Surplus batch is missing sales: ${batch.batchRoot}`);
  }

  const failedByRoot = new Map<string, SurplusFailedBatchAttempt>();
  for (const attempt of state.failedAttempts) failedByRoot.set(attempt.batchRoot, attempt);
  for (const entry of state.sales) {
    const proof = entry.vectorProof;
    if (proof.status !== "failed") continue;
    const attempt = failedByRoot.get(proof.batchRoot as string);
    if (
      attempt === undefined ||
      proof.leafIndex === null ||
      !verifySurplusMerkleProof(entry.sale, {
        saleHash: proof.saleHash,
        batchRoot: attempt.batchRoot,
        leafIndex: proof.leafIndex,
        leafCount: attempt.count,
        siblings: proof.siblings,
      })
    ) throw new Error(`Invalid failed proof for Surplus sale: ${entry.sale.saleId}`);
  }
}

function hashArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((item, index) => requiredHash(item, `${field}[${index}]`));
}

function requiredHash(value: unknown, field: string): string {
  if (!isHash(value)) throw new Error(`${field} must be a lowercase SHA-256 hash`);
  return value;
}


function isoTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) {
    throw new Error(`${field} must be an ISO timestamp`);
  }
  return value;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function emptyLedger(): SurplusVectorProofLedgerState {
  return {
    version: 1,
    sales: [],
    pendingBatch: null,
    confirmedBatches: [],
    failedAttempts: [],
  };
}

function cloneState(
  state: SurplusVectorProofLedgerState,
): SurplusVectorProofLedgerState {
  return structuredClone(state);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertOwnerAndType(info: Stats, directory: boolean, field: string): void {
  if (directory ? !info.isDirectory() : !info.isFile()) {
    throw new Error(`${field} has the wrong file type`);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`${field} must be owned by the service user`);
  }
}

function assertSecureOwner(info: Stats, directory: boolean, field: string): void {
  assertOwnerAndType(info, directory, field);
  if ((info.mode & 0o077) !== 0) {
    throw new Error(`${field} must not allow group or other access`);
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const FIXED_SIX_DECIMAL = /^(?:0|[1-9]\d*)\.\d{6}$/;
const HASH = /^[0-9a-f]{64}$/;
const TX_HASH = /^[0-9a-fA-F]{64}$/;
