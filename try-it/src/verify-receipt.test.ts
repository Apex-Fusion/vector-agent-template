/**
 * try-it/src/verify-receipt.test.ts — pins the buyer's offline verification
 * against receipts produced by the REAL vendored supplier path.
 *
 * Fixtures are not hand-written JSON: every receipt under test is built with
 * the same `buildReceipt` + `signReceipt` the agent's job runner calls
 * (`@marketplace/shared/receipt`), signed with a throwaway key generated here.
 * That makes the signature-layout mirror provable rather than asserted —
 * if the vendored signer ever changes what it serialises, these tests break.
 *
 * The wire contract under test (custom capability, Tasks 2-4):
 *   receipt.prompt_hash   === sha256(utf8(payload))   — the buyer's request bytes
 *   receipt.response_hash === sha256(utf8(output))    — the supplier's output bytes
 *   signature             === ed25519(canonical(receipt)) under the supplier key
 */

import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import * as ed from "@noble/ed25519";
import { blake2b } from "@noble/hashes/blake2b";

import { buildReceipt, signReceipt } from "@marketplace/shared/receipt";
import type { SignedReceipt } from "@marketplace/shared/receipt";

import { verifyReceipt } from "./verify-receipt.js";

// @noble/ed25519 v2 sync mode needs a sha512 hook. The vendored sign.ts
// installs one on import; we install ours too so key generation in this file
// does not depend on import order.
ed.etc.sha512Sync = (...messages: Uint8Array[]): Uint8Array => {
  const h = createHash("sha512");
  for (const m of messages) h.update(m);
  return new Uint8Array(h.digest());
};

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function bytesToHex(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, "0");
  return out;
}

const PAYLOAD = '[{"content":"the quick brown fox","role":"user"}]';
const OUTPUT = '{"echo":"[{\\"content\\":\\"the quick brown fox\\",\\"role\\":\\"user\\"}]","length":48}';
const ESCROW_REF = `${"ab".repeat(32)}#0`;

/** Throwaway supplier identity — private key never leaves this file. */
function makeSupplierKey(seed: string): { privHex: string; pubHex: string; pkh: string } {
  const privHex = sha256Hex(seed); // 32 bytes of deterministic entropy
  const pub = ed.getPublicKey(privHex);
  return {
    privHex,
    pubHex: bytesToHex(pub),
    pkh: bytesToHex(blake2b(pub, { dkLen: 28 })),
  };
}

/** Sign a receipt exactly the way the agent's custom job runner does. */
function makeSignedReceipt(opts: {
  payload: string;
  output: string;
  privHex: string;
  pkh: string;
}): SignedReceipt {
  const receipt = buildReceipt({
    prompt_hash: sha256Hex(opts.payload),
    response_hash: sha256Hex(opts.output),
    model: "echo-service-v1",
    prompt_tokens: 0,
    completion_tokens: 0,
    wallclock_ms: 12,
    supplier_pkh: opts.pkh,
    escrow_ref: ESCROW_REF,
  });
  return signReceipt(receipt, opts.privHex);
}

/** Round-trip through JSON the way the poll route delivers a receipt. */
function overTheWire(signed: SignedReceipt): { receipt: unknown; signature: unknown } {
  return JSON.parse(JSON.stringify({ receipt: signed.receipt, signature: signed.signature }));
}

describe("verifyReceipt", () => {
  const supplier = makeSupplierKey("try-it-fixture-supplier");

  it("accepts a receipt built and signed by the vendored supplier path", () => {
    const signed = makeSignedReceipt({
      payload: PAYLOAD,
      output: OUTPUT,
      privHex: supplier.privHex,
      pkh: supplier.pkh,
    });

    expect(verifyReceipt(signed, PAYLOAD, OUTPUT, supplier.pubHex)).toEqual({ ok: true });
  });

  it("accepts the same receipt after a JSON round-trip (key order is irrelevant)", () => {
    const signed = makeSignedReceipt({
      payload: PAYLOAD,
      output: OUTPUT,
      privHex: supplier.privHex,
      pkh: supplier.pkh,
    });

    expect(verifyReceipt(overTheWire(signed), PAYLOAD, OUTPUT, supplier.pubHex))
      .toEqual({ ok: true });
  });

  it("rejects when one byte of the output is tampered", () => {
    const signed = makeSignedReceipt({
      payload: PAYLOAD,
      output: OUTPUT,
      privHex: supplier.privHex,
      pkh: supplier.pkh,
    });
    const tampered = `${OUTPUT.slice(0, -2)}9}`; // last byte before "}" flipped

    const result = verifyReceipt(signed, PAYLOAD, tampered, supplier.pubHex);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("response_hash_mismatch");
  });

  it("rejects when the payload the buyer sent is not the payload the receipt commits", () => {
    const signed = makeSignedReceipt({
      payload: PAYLOAD,
      output: OUTPUT,
      privHex: supplier.privHex,
      pkh: supplier.pkh,
    });

    const result = verifyReceipt(signed, `${PAYLOAD} `, OUTPUT, supplier.pubHex);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("prompt_hash_mismatch");
  });

  it("rejects when a non-hashed receipt field is edited after signing", () => {
    const signed = makeSignedReceipt({
      payload: PAYLOAD,
      output: OUTPUT,
      privHex: supplier.privHex,
      pkh: supplier.pkh,
    });
    // Both hashes still match; only the signed serialisation changes.
    const edited = {
      receipt: { ...signed.receipt, model: "something-else-v9" },
      signature: signed.signature,
    };

    const result = verifyReceipt(edited, PAYLOAD, OUTPUT, supplier.pubHex);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signature_invalid");
  });

  it("rejects a receipt signed by a different supplier key", () => {
    const other = makeSupplierKey("some-other-supplier");
    const signed = makeSignedReceipt({
      payload: PAYLOAD,
      output: OUTPUT,
      privHex: other.privHex,
      pkh: supplier.pkh,
    });

    const result = verifyReceipt(signed, PAYLOAD, OUTPUT, supplier.pubHex);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signature_invalid");
  });

  it("rejects malformed inputs without throwing", () => {
    const signed = makeSignedReceipt({
      payload: PAYLOAD,
      output: OUTPUT,
      privHex: supplier.privHex,
      pkh: supplier.pkh,
    });

    expect(verifyReceipt({ receipt: null, signature: signed.signature }, PAYLOAD, OUTPUT, supplier.pubHex))
      .toEqual({ ok: false, reason: "malformed_receipt" });
    expect(verifyReceipt({ receipt: signed.receipt, signature: "nothex" }, PAYLOAD, OUTPUT, supplier.pubHex))
      .toEqual({ ok: false, reason: "malformed_signature" });
    expect(verifyReceipt(signed, PAYLOAD, OUTPUT, "zz"))
      .toEqual({ ok: false, reason: "malformed_pub_key" });
    expect(verifyReceipt({ receipt: { ...signed.receipt, prompt_hash: 42 }, signature: signed.signature }, PAYLOAD, OUTPUT, supplier.pubHex))
      .toEqual({ ok: false, reason: "malformed_receipt" });
  });
});
