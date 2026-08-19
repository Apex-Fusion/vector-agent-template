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

import { buildReceipt, signReceipt, receiptResultHash } from "@marketplace/shared/receipt";
import type { SignedReceipt } from "@marketplace/shared/receipt";

import { verifyReceipt, verifyChainBindings } from "./verify-receipt.js";

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

/**
 * The bindings are what stop a self-consistent lie: everything verifyReceipt
 * checks (receipt, output, signing key) arrives from ONE endpoint, so a
 * dishonest agent can serve a matched set. Each test below breaks exactly one
 * anchor to something the endpoint does not control.
 */
describe("verifyChainBindings", () => {
  const supplier = makeSupplierKey("try-it-bindings-supplier");

  function fixture(): { signed: SignedReceipt; onChain: string } {
    const signed = makeSignedReceipt({
      payload: PAYLOAD,
      output: OUTPUT,
      privHex: supplier.privHex,
      pkh: supplier.pkh,
    });
    // Exactly what the supplier's Submit tx writes: buildSubmitTx({receiptHash}).
    return { signed, onChain: receiptResultHash(signed) };
  }

  it("accepts a receipt whose hash is the one committed on chain", () => {
    const { signed, onChain } = fixture();
    expect(verifyChainBindings(signed, {
      resultReceiptHashOnChain: onChain,
      escrowRefPosted: ESCROW_REF,
      advertSupplierPkh: supplier.pkh,
      supplierPubKeyHex: supplier.pubHex,
    })).toEqual({ ok: true });
  });

  it("rejects a receipt the chain does not commit (result_receipt_hash)", () => {
    const { signed, onChain } = fixture();
    // One byte off — i.e. the endpoint served a receipt other than the one it
    // Submitted, or re-signed after the fact.
    const other = `${onChain.slice(0, -1)}${onChain.endsWith("0") ? "1" : "0"}`;
    expect(verifyChainBindings(signed, {
      resultReceiptHashOnChain: other,
      escrowRefPosted: ESCROW_REF,
      advertSupplierPkh: supplier.pkh,
      supplierPubKeyHex: supplier.pubHex,
    })).toEqual({ ok: false, reason: "result_receipt_hash_mismatch" });
  });

  it("rejects when the escrow has no receipt hash on chain at all", () => {
    const { signed } = fixture();
    expect(verifyChainBindings(signed, {
      resultReceiptHashOnChain: null,
      escrowRefPosted: ESCROW_REF,
      advertSupplierPkh: supplier.pkh,
      supplierPubKeyHex: supplier.pubHex,
    })).toEqual({ ok: false, reason: "no_result_receipt_hash_on_chain" });
  });

  it("rejects a receipt for someone else's escrow (replay)", () => {
    const { signed, onChain } = fixture();
    expect(verifyChainBindings(signed, {
      resultReceiptHashOnChain: onChain,
      escrowRefPosted: `${"cd".repeat(32)}#0`,
      advertSupplierPkh: supplier.pkh,
      supplierPubKeyHex: supplier.pubHex,
    })).toEqual({ ok: false, reason: "wrong_escrow_ref" });
  });

  it("rejects a receipt claiming a supplier the advert never named", () => {
    const { signed, onChain } = fixture();
    expect(verifyChainBindings(signed, {
      resultReceiptHashOnChain: onChain,
      escrowRefPosted: ESCROW_REF,
      advertSupplierPkh: "9f".repeat(28),
      supplierPubKeyHex: supplier.pubHex,
    })).toEqual({ ok: false, reason: "wrong_supplier" });
  });

  it("rejects a signing key that is not the advertised supplier's (circularity break)", () => {
    // The endpoint serves a receipt with the right supplier_pkh and a signature
    // that verifies — under a key it swapped in. blake2b-224 of that key does
    // not hash to the advert's pkh, so it fails.
    const impostor = makeSupplierKey("impostor-key");
    const signed = makeSignedReceipt({
      payload: PAYLOAD,
      output: OUTPUT,
      privHex: impostor.privHex,
      pkh: supplier.pkh,
    });
    expect(verifyReceipt(signed, PAYLOAD, OUTPUT, impostor.pubHex)).toEqual({ ok: true });
    expect(verifyChainBindings(signed, {
      resultReceiptHashOnChain: receiptResultHash(signed),
      escrowRefPosted: ESCROW_REF,
      advertSupplierPkh: supplier.pkh,
      supplierPubKeyHex: impostor.pubHex,
    })).toEqual({ ok: false, reason: "pub_key_not_supplier" });
  });
});
