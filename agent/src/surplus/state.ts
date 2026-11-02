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
import { dirname, basename, join } from "node:path";
import { randomUUID } from "node:crypto";

export interface SurplusOfferIntent {
  model: string;
  providerModelId: string;
  costMultiplierPpm: number;
  inputMicroUsdPer1m: number;
  outputMicroUsdPer1m: number;
  dailyCapUsd: number;
  baselineRemainingUsdNanos: string;
  idempotencyKey: string;
  createdAt: string;
  baselineTrades24h: number;
}

export interface SurplusSettlementEvidence {
  offerId: string | null;
  createdAt: string;
  sellerCostMicroUsd: number;
  settlementStatus: string;
}

export type SurplusControllerState =
  | { version: 1; phase: "selecting" }
  | { version: 1; phase: "create_pending"; intent: SurplusOfferIntent }
  | {
      version: 1;
      phase: "active";
      offerId: string;
      intent: SurplusOfferIntent;
      highestTrades24h: number;
    }
  | {
      version: 1;
      phase: "stopping";
      offerId: string;
      intent: SurplusOfferIntent;
      highestTrades24h: number;
      tradeObservedAt: string;
      pauseIdempotencyKey: string;
    }
  | {
      version: 1;
      phase: "awaiting_settlement";
      offerId: string;
      intent: SurplusOfferIntent;
      tradeObservedAt: string;
    }
  | {
      version: 1;
      phase: "completed";
      offerId: string;
      model: string;
      providerModelId: string;
      tradeObservedAt: string;
      completedAt: string;
      settlement: SurplusSettlementEvidence;
    };

export interface SurplusStateStore {
  load(): Promise<SurplusControllerState>;
  save(state: SurplusControllerState): Promise<void>;
}

export class FileSurplusStateStore implements SurplusStateStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<SurplusControllerState> {
    let handle: FileHandle;
    try {
      handle = await open(
        this.path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { version: 1, phase: "selecting" };
      throw error;
    }
    try {
      const info = await handle.stat();
      assertSecureOwner(info, false, "Surplus state file");
      const text = await handle.readFile("utf8");
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        throw new Error("Surplus state file is not valid JSON");
      }
      return parseState(value);
    } finally {
      await handle.close();
    }
  }

  async save(state: SurplusControllerState): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const directoryInfo = await lstat(directory);
    assertSecureOwner(directoryInfo, true, "Surplus state directory");
    const tempPath = join(directory, `.${basename(this.path)}.${randomUUID()}.tmp`);
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
      await rename(tempPath, this.path);
      const directoryHandle = await open(
        directory,
        constants.O_RDONLY | constants.O_DIRECTORY,
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
}

function assertSecureOwner(
  info: Stats,
  directory: boolean,
  field: string,
): void {
  if (directory ? !info.isDirectory() : !info.isFile()) {
    throw new Error(`${field} has the wrong file type`);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`${field} must be owned by the service user`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error(`${field} must not allow group or other access`);
  }
}

function parseState(value: unknown): SurplusControllerState {
  const root = object(value, "Surplus state");
  if (root.version !== 1) throw new Error("Surplus state version must be 1");
  const phase = nonEmptyString(root.phase, "Surplus state phase");
  if (phase === "selecting") return { version: 1, phase };
  if (phase === "create_pending") {
    return { version: 1, phase, intent: parseIntent(root.intent) };
  }
  if (phase === "active") {
    return {
      version: 1,
      phase,
      offerId: nonEmptyString(root.offerId, "Surplus state offerId"),
      intent: parseIntent(root.intent),
      highestTrades24h: nonNegativeInteger(
        root.highestTrades24h,
        "Surplus state highestTrades24h",
      ),
    };
  }
  if (phase === "stopping") {
    return {
      version: 1,
      phase,
      offerId: nonEmptyString(root.offerId, "Surplus state offerId"),
      intent: parseIntent(root.intent),
      highestTrades24h: nonNegativeInteger(
        root.highestTrades24h,
        "Surplus state highestTrades24h",
      ),
      tradeObservedAt: isoTimestamp(
        root.tradeObservedAt,
        "Surplus state tradeObservedAt",
      ),
      pauseIdempotencyKey: nonEmptyString(
        root.pauseIdempotencyKey,
        "Surplus state pauseIdempotencyKey",
      ),
    };
  }
  if (phase === "awaiting_settlement") {
    return {
      version: 1,
      phase,
      offerId: nonEmptyString(root.offerId, "Surplus state offerId"),
      intent: parseIntent(root.intent),
      tradeObservedAt: isoTimestamp(
        root.tradeObservedAt,
        "Surplus state tradeObservedAt",
      ),
    };
  }
  if (phase === "completed") {
    return {
      version: 1,
      phase,
      offerId: nonEmptyString(root.offerId, "Surplus state offerId"),
      model: nonEmptyString(root.model, "Surplus state model"),
      providerModelId: nonEmptyString(
        root.providerModelId,
        "Surplus state providerModelId",
      ),
      tradeObservedAt: isoTimestamp(
        root.tradeObservedAt,
        "Surplus state tradeObservedAt",
      ),
      completedAt: isoTimestamp(root.completedAt, "Surplus state completedAt"),
      settlement: parseSettlement(root.settlement),
    };
  }
  throw new Error(`Surplus state phase is unsupported: ${phase}`);
}

function parseSettlement(value: unknown): SurplusSettlementEvidence {
  const settlement = object(value, "Surplus state settlement");
  const offerId = settlement.offerId;
  if (offerId !== null && (typeof offerId !== "string" || offerId === "")) {
    throw new Error("Surplus state settlement.offerId must be a string or null");
  }
  return {
    offerId,
    createdAt: isoTimestamp(
      settlement.createdAt,
      "Surplus state settlement.createdAt",
    ),
    sellerCostMicroUsd: positiveInteger(
      settlement.sellerCostMicroUsd,
      "Surplus state settlement.sellerCostMicroUsd",
    ),
    settlementStatus: nonEmptyString(
      settlement.settlementStatus,
      "Surplus state settlement.settlementStatus",
    ),
  };
}

function parseIntent(value: unknown): SurplusOfferIntent {
  const intent = object(value, "Surplus state intent");
  return {
    model: nonEmptyString(intent.model, "Surplus state intent.model"),
    providerModelId: nonEmptyString(
      intent.providerModelId,
      "Surplus state intent.providerModelId",
    ),
    costMultiplierPpm: positiveInteger(
      intent.costMultiplierPpm,
      "Surplus state intent.costMultiplierPpm",
    ),
    inputMicroUsdPer1m: positiveInteger(
      intent.inputMicroUsdPer1m,
      "Surplus state intent.inputMicroUsdPer1m",
    ),
    outputMicroUsdPer1m: positiveInteger(
      intent.outputMicroUsdPer1m,
      "Surplus state intent.outputMicroUsdPer1m",
    ),
    dailyCapUsd: positiveNumber(
      intent.dailyCapUsd,
      "Surplus state intent.dailyCapUsd",
    ),
    baselineRemainingUsdNanos: nonNegativeIntegerString(
      intent.baselineRemainingUsdNanos,
      "Surplus state intent.baselineRemainingUsdNanos",
    ),
    idempotencyKey: nonEmptyString(
      intent.idempotencyKey,
      "Surplus state intent.idempotencyKey",
    ),
    createdAt: isoTimestamp(intent.createdAt, "Surplus state intent.createdAt"),
    baselineTrades24h: nonNegativeInteger(
      intent.baselineTrades24h,
      "Surplus state intent.baselineTrades24h",
    ),
  };
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function nonNegativeIntegerString(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${field} must be a non-negative integer string`);
  }
  return value;
}

function isoTimestamp(value: unknown, field: string): string {
  const timestamp = nonEmptyString(value, field);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`${field} must be an ISO timestamp`);
  }
  return timestamp;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function positiveNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive finite number`);
  }
  return value;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
