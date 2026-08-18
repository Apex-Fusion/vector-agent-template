/**
 * tx/signer.ts — signing interface for tx builders.
 *
 * Provides a minimal Signer abstraction so tx builders can be tested
 * with a deterministic mock without binding to any specific wallet library.
 */

/**
 * Signer — abstracts signing a tx body hash.
 * Returns a 64-byte Ed25519 signature as hex.
 */
export interface Signer {
  sign(txBodyHash: string): Promise<string>;
  pubKeyHash(): string;
  address(): string;
}

/**
 * MockSigner — deterministic test signer.
 * Returns a fixed 64-byte all-zeros signature (sufficient for unit tests
 * that assert structure, not cryptographic validity).
 */
export class MockSigner implements Signer {
  private readonly _pubKeyHash: string;
  private readonly _address: string;

  constructor(pubKeyHash: string, address: string) {
    this._pubKeyHash = pubKeyHash;
    this._address = address;
  }

  async sign(_txBodyHash: string): Promise<string> {
    // Deterministic 64-byte all-zero Ed25519 signature placeholder. Sufficient
    // for unit tests that assert structure, not cryptographic validity.
    return "0".repeat(128);
  }

  pubKeyHash(): string {
    return this._pubKeyHash;
  }

  address(): string {
    return this._address;
  }
}
