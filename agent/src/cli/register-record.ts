/**
 * register-record.ts — CLI entry point for
 *   `pnpm --filter @marketplace/supplier tx:register-record <build|sign|submit>`.
 *
 * Registers the identity record of a supplier key (Part 2 §9.2) before the
 * key posts a new advert. The controller is the Foundation operator key,
 * whose private key stays offline, so registration has three steps:
 *
 *   build  --out <file> [--name <text>] [--description <text>] [--endpoint <url>]
 *          [--capability <id>]...
 *       Builds the Register transaction, signs it with the supplier key and
 *       writes the registration file (mode 0600; it holds no secret). It
 *       refuses when a live record already lists the supplier key. Without
 *       --capability it takes the capability_id of the key's Active adverts.
 *       Env: SUPPLIER_PRIV_KEY_HEX, NETWORK_ID, OGMIOS_URL (required when
 *       NETWORK_ID=1), IDENTITY_POLICY_ID, IDENTITY_REF_UTXO (the reference
 *       script of the identity contract), IDENTITY_CONTROLLER_PUB_KEY_HEX,
 *       IDENTITY_ACCOUNTABLE_PARTY (optional: "controller" (default) or a
 *       56-hex key hash, which then also signs), VECTOR_ZERO_TIME_MS
 *       (NETWORK_ID=0 only). The protocol parameters come from Ogmios.
 *   sign   --tx <file>
 *       Adds one signature, for example the controller's on the offline
 *       machine. Env: SIGNER_PRIV_KEY_HEX. No network access.
 *   submit --tx <file> [--await-timeout-ms N]
 *       Checks that every required signer signed, submits, waits, and prints
 *       AGENT_ID=<64 hex>. Env: OGMIOS_URL (required for the mainnet file).
 *
 * Set AGENT_ID in the supplier env afterwards; tx:post-advert --agent-id
 * posts the new advert. The Register window is one hour from the build.
 */

import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { signTransaction, transactionId } from "@marketplace/shared";
import { LiveOgmiosProvider, type ChainProvider, type OutputReference } from "@marketplace/shared/chain";
import { loadBlueprint, loadIdentityBlueprint } from "@marketplace/shared/tx";
import { deriveSupplierKey } from "../paper2agent/identity.js";
import {
  advertCapabilities,
  buildRegistration,
  missingSigners,
  parseAccountableParty,
  parseControllerKey,
  parseRegistration,
  recordsListingKey,
  registerWindow,
  signRegistration,
  submitRegistration,
  supplierRecord,
  type RecordRegistrar,
  type RegistrationFile,
  type TransactionWitnesses,
} from "../identity/register.js";
import { chainRegistrar, ogmiosProtocolParameters, vectorSlotConfig } from "../identity/registrar.js";

const TESTNET_OGMIOS_DEFAULT = "https://ogmios.vector.testnet.apexfusion.org";
const DEFAULT_AWAIT_TIMEOUT_MS = 120_000;

export type RegisterCommand =
  | { command: "build"; out: string; name?: string; description: string; endpoint: string; capabilities: string[] }
  | { command: "sign"; tx: string }
  | { command: "submit"; tx: string; awaitTimeoutMs: number };

export interface RegisterRecordDeps {
  /** The Register builder. Default: the shared builder over Ogmios (registrar.ts). */
  registrar?: RecordRegistrar;
  /** Chain for build and submit. Default: Ogmios at OGMIOS_URL. */
  chain?: ChainProvider;
  now?: () => number;
  out?: (line: string) => void;
}

/** The shared witness helpers: sign and submit need no builder and no deployment setting. */
const SHARED_WITNESSES: TransactionWitnesses = { sign: signTransaction, txId: transactionId };

const VALUE_FLAGS: Record<string, true> = {
  "--out": true, "--name": true, "--description": true, "--endpoint": true, "--capability": true,
  "--tx": true, "--await-timeout-ms": true,
};

/** argv → command. Unknown commands, flags and flags of another command throw. */
export function parseRegisterArgs(argv: string[]): RegisterCommand {
  const [command, ...rest] = argv;
  const values: Record<string, string> = {};
  const capabilities: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    const value = rest[i + 1];
    if (VALUE_FLAGS[flag] !== true) throw new Error(`unknown flag: ${flag}`);
    if (value === undefined) throw new Error(`flag ${flag} requires a value`);
    if (flag === "--capability") capabilities.push(value);
    else values[flag] = value;
    i++;
  }
  const allowed = (flags: string[]): void => {
    const extra = [...Object.keys(values), ...(capabilities.length > 0 ? ["--capability"] : [])]
      .find((flag) => !flags.includes(flag));
    if (extra !== undefined) throw new Error(`flag ${extra} does not apply to ${command}`);
  };
  switch (command) {
    case "build": {
      allowed(["--out", "--name", "--description", "--endpoint", "--capability"]);
      const out = values["--out"];
      if (out === undefined) throw new Error("build requires --out <file>");
      return { command, out, name: values["--name"], description: values["--description"] ?? "",
        endpoint: values["--endpoint"] ?? "", capabilities };
    }
    case "sign": {
      allowed(["--tx"]);
      const tx = values["--tx"];
      if (tx === undefined) throw new Error("sign requires --tx <file>");
      return { command, tx };
    }
    case "submit": {
      allowed(["--tx", "--await-timeout-ms"]);
      const tx = values["--tx"];
      if (tx === undefined) throw new Error("submit requires --tx <file>");
      const raw = values["--await-timeout-ms"];
      const awaitTimeoutMs = raw === undefined ? DEFAULT_AWAIT_TIMEOUT_MS : Number(raw);
      if (!Number.isSafeInteger(awaitTimeoutMs) || awaitTimeoutMs <= 0) throw new Error("--await-timeout-ms must be a positive integer");
      return { command, tx, awaitTimeoutMs };
    }
    default:
      throw new Error("usage: tx:register-record <build|sign|submit> [flags]");
  }
}

function networkOf(env: Record<string, string | undefined>): 0 | 1 {
  const raw = env.NETWORK_ID;
  if (raw !== "0" && raw !== "1") throw new Error(`NETWORK_ID must be "0" or "1", got: ${raw ?? "(unset)"}`);
  return raw === "1" ? 1 : 0;
}

function ogmiosUrlFor(env: Record<string, string | undefined>, networkId: 0 | 1): string {
  if (env.OGMIOS_URL) return env.OGMIOS_URL;
  if (networkId === 0) return TESTNET_OGMIOS_DEFAULT;
  throw new Error("OGMIOS_URL is required when NETWORK_ID=1");
}

function privateKey(env: Record<string, string | undefined>, name: string): string {
  const value = env[name] ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} must be 64 hex characters`);
  return value.toLowerCase();
}

/** IDENTITY_REF_UTXO: the reference script of the identity contract, "<64 hex>#<index>". */
function identityRef(env: Record<string, string | undefined>): OutputReference {
  const match = /^([0-9a-f]{64})#(0|[1-9]\d{0,4})$/.exec(env.IDENTITY_REF_UTXO ?? "");
  if (!match) throw new Error("IDENTITY_REF_UTXO must be <64 lowercase hex>#<index> (the identity reference script)");
  return { txHash: match[1]!, index: Number(match[2]) };
}

/** Writes the registration file: create only, or replace through a private temporary file. */
function writeRegistration(path: string, file: RegistrationFile, replace: boolean): void {
  const body = `${JSON.stringify(file, null, 2)}\n`;
  const target = replace ? `${path}.${randomBytes(8).toString("hex")}.tmp` : path;
  const fd = openSync(target, "wx", 0o600);
  try {
    writeFileSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (replace) renameSync(target, path);
}

async function build(
  command: Extract<RegisterCommand, { command: "build" }>,
  env: Record<string, string | undefined>,
  deps: RegisterRecordDeps,
  out: (line: string) => void,
): Promise<void> {
  const networkId = networkOf(env);
  const wallet = deriveSupplierKey(privateKey(env, "SUPPLIER_PRIV_KEY_HEX"), networkId);
  const controller = parseControllerKey(env.IDENTITY_CONTROLLER_PUB_KEY_HEX);
  const accountable = parseAccountableParty(env.IDENTITY_ACCOUNTABLE_PARTY);
  const blueprint = loadIdentityBlueprint({ identityHash: env.IDENTITY_POLICY_ID ?? "" });
  const ogmiosUrl = ogmiosUrlFor(env, networkId);
  const chain = deps.chain ?? new LiveOgmiosProvider({ ogmiosUrl });
  const registrar = deps.registrar ?? chainRegistrar({ chain, networkId, identityHash: blueprint.identityHash,
    identityRef: identityRef(env), protocolParameters: () => ogmiosProtocolParameters(ogmiosUrl),
    slotConfig: vectorSlotConfig(networkId, env.VECTOR_ZERO_TIME_MS) });

  const listed = await recordsListingKey(chain, blueprint, networkId, wallet.pubKeyHash);
  if (listed.length > 0) {
    throw new Error(`supplier key ${wallet.pubKeyHash} is already listed in record ${listed.join(", ")}; ` +
      `set AGENT_ID=${listed[0]} instead of registering again`);
  }
  const capabilities = command.capabilities.length > 0
    ? command.capabilities
    : await advertCapabilities(chain,
      [loadBlueprint().advertScriptAddress(networkId), blueprint.advertScriptAddress(networkId)], wallet.pubKeyHash);
  if (capabilities.length === 0) {
    throw new Error("the supplier key has no Active advert: pass --capability <capability_id> for each capability");
  }
  const window = registerWindow((deps.now ?? Date.now)());
  const record = supplierRecord({
    controller,
    accountable,
    supplierPubKeyHex: wallet.pubKeyHex,
    profile: {
      name: command.name ?? `supplier ${wallet.pubKeyHash.slice(0, 16)}`,
      description: command.description,
      endpoint: command.endpoint,
      capabilities,
    },
    window,
  });
  const file = await buildRegistration(registrar, { ...record, wallet, window, networkId });
  writeRegistration(command.out, file, false);
  out(`agent_id: ${file.agent_id}`);
  out(`agent_did: ${file.agent_did}`);
  out(`registration file: ${command.out}`);
  out(`signers still needed: ${missingSigners(file).join(", ")}`);
  out(`submit before: ${new Date(file.valid_until_ms).toISOString()}`);
}

async function sign(
  command: Extract<RegisterCommand, { command: "sign" }>,
  env: Record<string, string | undefined>,
  deps: RegisterRecordDeps,
  out: (line: string) => void,
): Promise<void> {
  const file = parseRegistration(readFileSync(command.tx, "utf8"));
  const signer = deriveSupplierKey(privateKey(env, "SIGNER_PRIV_KEY_HEX"), file.network_id);
  const signed = await signRegistration(deps.registrar ?? SHARED_WITNESSES, file, signer.privateKeyHex, signer.pubKeyHex);
  writeRegistration(command.tx, signed, true);
  const missing = missingSigners(signed);
  out(`signed by ${signer.pubKeyHash}`);
  out(missing.length === 0 ? "all signers signed: run submit" : `signers still needed: ${missing.join(", ")}`);
}

async function submit(
  command: Extract<RegisterCommand, { command: "submit" }>,
  env: Record<string, string | undefined>,
  deps: RegisterRecordDeps,
  out: (line: string) => void,
): Promise<void> {
  const file = parseRegistration(readFileSync(command.tx, "utf8"));
  const chain = deps.chain ?? new LiveOgmiosProvider({ ogmiosUrl: ogmiosUrlFor(env, file.network_id) });
  const agentId = await submitRegistration(deps.registrar ?? SHARED_WITNESSES, chain, file,
    { nowMs: (deps.now ?? Date.now)(), awaitTimeoutMs: command.awaitTimeoutMs });
  out(`AGENT_ID=${agentId}`);
}

/** Runs one command. Returns the exit code; errors go to stderr as "error: <message>". */
export async function runRegisterRecord(
  argv: string[],
  env: Record<string, string | undefined>,
  deps: RegisterRecordDeps = {},
): Promise<number> {
  const out = deps.out ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  try {
    const command = parseRegisterArgs(argv);
    if (command.command === "build") await build(command, env, deps, out);
    else if (command.command === "sign") await sign(command, env, deps, out);
    else await submit(command, env, deps, out);
    return 0;
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

if (process.argv[1]?.endsWith("register-record.ts") || process.argv[1]?.endsWith("register-record.js")) {
  runRegisterRecord(process.argv.slice(2), process.env).then((code) => process.exit(code));
}
