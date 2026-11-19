import { describe, it as test, expect } from 'vitest';
import { MAX_CBOR_DEPTH, CborGuardError, assertCborDepth, assertCborHexDepth, cborDepth } from './cbor-depth.js';

// Ported from the tests of Apex-Fusion/mcp-server. `assert` is a small stand-in for the assertions of node:assert that these tests
// use, on top of the assertions of vitest.

interface Assert {
  ok(value: unknown, message?: string): asserts value;
  equal(actual: unknown, expected: unknown, message?: string): void;
  match(text: string, pattern: RegExp, message?: string): void;
  fail(message?: string): never;
  doesNotThrow(fn: () => unknown, message?: string): void;
  throws(fn: () => unknown, validate: ((error: unknown) => boolean) | RegExp, message?: string): void;
}

const assert: Assert = {
  ok(value: unknown, message?: string): asserts value {
    expect(Boolean(value), message).toBe(true);
  },
  equal(actual: unknown, expected: unknown, message?: string): void {
    expect(actual, message).toBe(expected);
  },
  match(text: string, pattern: RegExp, message?: string): void {
    expect(text, message).toMatch(pattern);
  },
  fail(message?: string): never {
    throw new Error(message ?? 'failed');
  },
  doesNotThrow(fn: () => unknown, message?: string): void {
    try {
      fn();
    } catch (error) {
      throw new Error(`${message ?? 'the call threw'}: ${String(error)}`);
    }
  },
  /** The call must throw, and `validate` (a function that returns true, or a pattern for the message) must accept what it threw. */
  throws(fn: () => unknown, validate: ((error: unknown) => boolean) | RegExp, message?: string): void {
    let thrown: unknown;
    let threw = false;
    try {
      fn();
    } catch (error) {
      threw = true;
      thrown = error;
    }
    expect(threw, message ?? 'the call did not throw').toBe(true);
    if (validate instanceof RegExp) expect(String((thrown as Error | undefined)?.message ?? thrown), message).toMatch(validate);
    else expect(validate(thrown), message).toBe(true);
  },
};

// The CBOR depth check: what it counts as a level, what it accepts and refuses, and that its work does not depend on the shape of
// the input. Every value is spelled in hex; `bytes` takes the spaces out.

const bytes = (hex: string): Uint8Array => Buffer.from(hex.replace(/\s+/g, ''), 'hex');
const rep = (piece: string, times: number): string => piece.repeat(times);
/** A definite-length byte string that holds `hex` (spaces are taken out). */
const bytesOf = (hex: string): string => {
  const content = hex.replace(/\s+/g, '');
  const length = content.length / 2;
  const head = length < 24 ? (0x40 + length).toString(16).padStart(2, '0') : length < 256 ? `58${length.toString(16).padStart(2, '0')}` : length < 65536 ? `59${length.toString(16).padStart(4, '0')}` : `5a${length.toString(16).padStart(8, '0')}`;
  return `${head}${content}`;
};
/** The value under tag 24: CBOR in CBOR. */
const embedded = (hex: string): string => `d818${bytesOf(hex)}`;

/** `n` levels of nesting, by kind; the leaf is the integer 0. */
const SHAPES: Record<string, (n: number) => string> = {
  'arrays': (n) => `${rep('81', n)}00`,
  'indefinite-length arrays': (n) => `${rep('9f', n)}00${rep('ff', n)}`,
  'maps, nested in the value': (n) => `${rep('a100', n)}00`,
  'maps, nested in the key': (n) => `${rep('a1', n)}00${rep('00', n)}`,
  'indefinite-length maps': (n) => `${rep('bf00', n)}00${rep('ff', n)}`,
  'tags': (n) => `${rep('c1', n)}00`,
};

const refusal = (reason: 'depth' | 'format', message?: RegExp) => (err: unknown): boolean => {
  assert.ok(err instanceof CborGuardError, `expected a CborGuardError, got ${String(err)}`);
  assert.ok(err instanceof Error);
  assert.equal(err.reason, reason, err.message);
  if (message) assert.match(err.message, message);
  return true;
};

describe('cborDepth: what counts as a level', () => {
  // [description, hex, levels]: the examples of RFC 8949 Appendix A, and the shapes that Plutus data and transactions use.
  const cases: Array<[string, string, number]> = [
    ['an unsigned integer', '00', 0], ['an unsigned integer of one byte', '1818', 0], ['an unsigned integer of two bytes', '1903e8', 0],
    ['an unsigned integer of four bytes', '1a000f4240', 0], ['an unsigned integer of eight bytes', '1b000000e8d4a51000', 0], ['the largest unsigned integer', '1bffffffffffffffff', 0],
    ['a negative integer', '3903e7', 0], ['the smallest negative integer', '3bffffffffffffffff', 0],
    ['a bignum: tag 2 and a byte string', 'c249010000000000000000', 1], ['a negative bignum', 'c349010000000000000000', 1],
    ['a half float', 'f93c00', 0], ['a single float', 'fa47c35000', 0], ['a double float', 'fb3ff199999999999a', 0],
    ['false', 'f4', 0], ['true', 'f5', 0], ['null', 'f6', 0], ['undefined', 'f7', 0],
    ['a simple value', 'f0', 0], ['a simple value in one byte', 'f8ff', 0],
    ['an empty byte string', '40', 0], ['a byte string', '4401020304', 0], ['an empty text string', '60', 0], ['a text string', '6449455446', 0], ['a text string with UTF-8', '63e6b0b4', 0],
    ['a tag and a text string', 'c074323031332d30332d32315432303a30343a30305a', 1], ['a tag 23 and a byte string', 'd74401020304', 1],
    ['an empty array', '80', 1], ['an array of integers', '83010203', 1], ['arrays in an array', '8301820203820405', 2],
    ['an array of 25 integers', '98190102030405060708090a0b0c0d0e0f101112131415161718181819', 1],
    ['an empty map', 'a0', 1], ['a map of integers', 'a201020304', 1], ['a map with an array', 'a26161016162820203', 2], ['an array with a map', '826161a161626163', 2],
    ['an indefinite-length byte string', '5f42010243030405ff', 0], ['an indefinite-length text string', '7f657374726561646d696e67ff', 0],
    ['an empty indefinite-length array', '9fff', 1], ['an indefinite-length array in an array', '9f018202039f0405ffff', 2],
    ['a definite array in an indefinite one', '83018202039f0405ff', 2], ['an indefinite array in a definite one', '83019f0203ff820405', 2],
    ['an empty indefinite-length map', 'bfff', 1], ['an indefinite-length map with an indefinite array', 'bf61610161629f0203ffff', 2], ['an indefinite-length map in an array', '826161bf61626163ff', 2],
    ['a Plutus constructor without fields', 'd87980', 2], ['a Plutus constructor with fields', 'd8799f0102ff', 2], ['a constructor in a constructor', 'd8799fd87980ff', 4],
    ['a byte string under a tag that is not 24', 'd9ffff4401020304', 1],
  ];
  for (const [description, hex, levels] of cases) {
    test(`${description} has ${levels} level${levels === 1 ? '' : 's'}`, () => {
      assert.equal(cborDepth(bytes(hex)), levels);
    });
  }

  test('an empty array or map is a level of its own', () => {
    assert.equal(cborDepth(bytes(`${rep('81', 3)}80`)), 4);
    assert.equal(cborDepth(bytes(`${rep('81', 3)}a0`)), 4);
    assert.equal(cborDepth(bytes(`${rep('81', 3)}9fff`)), 4);
  });

  test('has the limit of the scanner: 64 levels by default, and the first level past the limit is refused', () => {
    assert.equal(cborDepth(bytes(`${rep('81', 64)}00`)), 64);
    assert.throws(() => cborDepth(bytes(`${rep('81', 65)}00`)), refusal('depth', /nested deeper than 64 levels/));
    assert.throws(() => cborDepth(bytes(`${rep('81', 5000)}00`)), refusal('depth'));
    assert.equal(cborDepth(bytes(`${rep('81', 100)}00`), 100), 100);
    assert.throws(() => cborDepth(bytes(`${rep('81', 101)}00`), 100), refusal('depth', /nested deeper than 100 levels/));
  });

  test('each level around an item is counted, for each kind', () => {
    for (const [name, shape] of Object.entries(SHAPES)) assert.equal(cborDepth(bytes(shape(5))), 5, name);
    assert.equal(cborDepth(bytes(`${rep('d87981', 5)}d87980`)), 12, 'constructors with one field each');
    assert.equal(cborDepth(bytes(`${rep('d8799f', 5)}d87980${rep('ff', 5)}`)), 12, 'constructors with indefinite-length fields');
  });

  test('the first item is read and the bytes after it are not', () => {
    assert.equal(cborDepth(bytes('00ff')), 0);
    assert.equal(cborDepth(bytes('8100ffff')), 1);
    assert.equal(cborDepth(bytes('d879801c')), 2);
    assert.equal(cborDepth(bytes(`00${rep('81', 500)}00`)), 0, 'a deep item after the first is not read');
  });
});

describe('assertCborDepth: the limit', () => {
  test('the default limit is 64 levels', () => {
    assert.equal(MAX_CBOR_DEPTH, 64);
  });

  for (const [name, shape] of Object.entries(SHAPES)) {
    test(`${name}: 64 levels are accepted and 65 are refused`, () => {
      assert.doesNotThrow(() => assertCborDepth(bytes(shape(64))));
      assert.throws(() => assertCborDepth(bytes(shape(65))), refusal('depth', /nested deeper than 64 levels/));
    });
  }

  test('constructors are a tag and an array: 64 levels are accepted and 66 are refused', () => {
    assert.doesNotThrow(() => assertCborDepth(bytes(`${rep('d87981', 32)}00`)), '32 constructors with a leaf: 64 levels');
    assert.doesNotThrow(() => assertCborDepth(bytes(`${rep('d87981', 31)}d87980`)), '31 constructors and an empty one: 64 levels');
    assert.throws(() => assertCborDepth(bytes(`${rep('d87981', 33)}00`)), refusal('depth'), '33 constructors with a leaf: 66 levels');
    assert.throws(() => assertCborDepth(bytes(`${rep('d87981', 32)}d87980`)), refusal('depth'), '32 constructors and an empty one: 66 levels');
    assert.throws(() => assertCborDepth(bytes(`${rep('d8799f', 33)}00${rep('ff', 33)}`)), refusal('depth'), 'with indefinite-length fields');
  });

  test('an empty array that is the 65th level is refused', () => {
    assert.doesNotThrow(() => assertCborDepth(bytes(`${rep('81', 63)}80`)));
    assert.throws(() => assertCborDepth(bytes(`${rep('81', 64)}80`)), refusal('depth'));
  });

  test('a limit can be given: the same value is inside one limit and outside another', () => {
    const value = bytes(`${rep('81', 10)}00`);
    assert.doesNotThrow(() => assertCborDepth(value, { what: 'The value', limit: 10 }));
    assert.throws(() => assertCborDepth(value, { what: 'The value', limit: 9 }), refusal('depth', /^The value is nested deeper than 9 levels\.$/));
    assert.doesNotThrow(() => assertCborDepth(bytes(`${rep('81', 200)}00`), { what: 'The value', limit: 200 }));
  });

  test('the message names the value', () => {
    assert.throws(() => assertCborDepth(bytes(`${rep('81', 65)}00`), { what: 'The datum of the output' }), refusal('depth', /^The datum of the output is nested deeper than 64 levels\.$/));
  });

  test('a refusal is an ordinary Error with a name and a reason', () => {
    try {
      assertCborDepth(bytes(`${rep('81', 65)}00`));
      assert.fail('expected a refusal');
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.equal((err as CborGuardError).name, 'CborGuardError');
      assert.equal((err as CborGuardError).reason, 'depth');
    }
  });

  test('a long input that nests from its first byte is refused at once, at any size', () => {
    const size = 5_000_000;
    for (const piece of ['81', '9f', 'bf00', 'c1', 'd87981', 'd8799f', 'a1', 'a100']) {
      const input = Buffer.alloc(size, Buffer.from(piece, 'hex'));
      const started = performance.now();
      assert.throws(() => assertCborDepth(input), refusal('depth'), piece);
      assert.ok(performance.now() - started < 1000, `${piece}: took ${performance.now() - started} ms`);
    }
  });
});

describe('assertCborDepth: CBOR in CBOR (tag 24)', () => {
  test('the levels inside the bytes add to the levels around them', () => {
    assert.equal(cborDepth(bytes(embedded('81 00'))), 2, 'the tag, and the array in the bytes');
    assert.equal(cborDepth(bytes(`82 01 ${embedded('d87980')}`)), 4, 'an array, the tag, and a constructor');
    assert.equal(cborDepth(bytes(embedded(embedded('81 00')))), 3, 'a tag in the bytes of a tag');
  });

  test('the bytes under tag 24 are read: 64 levels with the tag are accepted, and 65 are refused', () => {
    assert.doesNotThrow(() => assertCborDepth(bytes(embedded(`${rep('81', 63)}00`))));
    assert.throws(() => assertCborDepth(bytes(embedded(`${rep('81', 64)}00`))), refusal('depth'));
  });

  test('the same bytes under another tag are a byte string that nothing reads into', () => {
    const nested = `${rep('81', 5000)}00`;
    assert.doesNotThrow(() => assertCborDepth(bytes(`d819${bytesOf(nested)}`)));
    assert.throws(() => assertCborDepth(bytes(`d818${bytesOf(nested)}`)), refusal('depth'));
  });

  test('tag 24 is also tag 24 when its number is written in more bytes', () => {
    const nested = bytesOf(`${rep('81', 64)}00`);
    for (const tag of ['d818', 'd90018', 'da00000018', 'db0000000000000018']) {
      assert.throws(() => assertCborDepth(bytes(`${tag}${nested}`)), refusal('depth'), tag);
    }
    // A tag number that only ends in the bits of 24 is another tag.
    assert.doesNotThrow(() => assertCborDepth(bytes(`db0000000100000018${nested}`)));
  });

  test('a datum in an output of a transaction is read at the levels of the transaction around it', () => {
    // A transaction {1: [output]} with a Babbage output {0: address, 1: coin, 2: [1, #6.24(datum)]}.
    const address = `581d61${'11'.repeat(28)}`;
    const tx = (datum: string): string => `84 a1 01 81 a3 00 ${address} 01 1a001e8480 02 82 01 ${embedded(datum)} a0 f5 f6`;
    // Around the datum: the transaction, the body, the outputs, the output, the datum option and the tag: 6 levels.
    assert.equal(cborDepth(bytes(tx('00'))), 6);
    assert.doesNotThrow(() => assertCborDepth(bytes(tx(`${rep('81', 58)}00`)), { kind: 'transaction' }));
    assert.throws(() => assertCborDepth(bytes(tx(`${rep('81', 59)}00`)), { kind: 'transaction' }), refusal('depth'));
  });

  test('a native script in the reference script of an output is read at the levels of the transaction around it', () => {
    // {0: address, 1: coin, 3: #6.24([0, script])} in the same transaction. A nested script is [1, [script]] in each level (two levels).
    const address = `581d61${'11'.repeat(28)}`;
    const keyScript = `8200581c${'00'.repeat(28)}`;
    for (const [levels, accepted] of [[28, true], [29, false]] as const) {
      const tx = `84 a1 01 81 a3 00 ${address} 01 1a001e8480 03 ${embedded(`8200 ${rep('820181', levels)}${keyScript}`)} a0 f5 f6`;
      // The transaction, the body, the outputs, the output, the tag, the pair, the script levels, and the key script: 7 + 2 * levels.
      assert.equal(cborDepth(bytes(tx), 100), 7 + 2 * levels);
      if (accepted) assert.doesNotThrow(() => assertCborDepth(bytes(tx), { kind: 'transaction' }));
      else assert.throws(() => assertCborDepth(bytes(tx), { kind: 'transaction' }), refusal('depth'));
    }
  });

  test('only the first item of the bytes is read', () => {
    assert.equal(cborDepth(bytes('d818 43 00 ffff')), 1);
    assert.equal(cborDepth(bytes(`82 ${embedded('00')} 00`)), 2);
    assert.equal(cborDepth(bytes(`d818 45 00 ${rep('81', 4)}`)), 1, 'what follows the first item in the bytes is not read');
  });

  test('a tag 24 over something that is not a byte string is an ordinary tag', () => {
    assert.equal(cborDepth(bytes('d81880')), 2);
    assert.equal(cborDepth(bytes('d81800')), 1);
    assert.equal(cborDepth(bytes('d8186161')), 1);
  });

  test('a byte string that is written in chunks is read after its chunks are joined', () => {
    // The chunks join into h'81 00': the array header is in one chunk and its item in the next.
    assert.equal(cborDepth(bytes('d818 5f 41 81 41 00 ff')), 2);
    // A header that is cut between two chunks: 18 05 is the integer 5.
    assert.equal(cborDepth(bytes('d818 5f 41 18 41 05 ff')), 1);
    // The chunks join into a tag 24 of its own.
    assert.equal(cborDepth(bytes('d818 5f 42 d818 42 4100 ff')), 2);
    // What follows the first item of the joined bytes is not read.
    assert.equal(cborDepth(bytes('d818 5f 42 00 ff ff')), 1);
  });

  test('the bytes after a byte string in chunks are read at their place in the outer bytes', () => {
    // [h'81 00' in chunks, then a value that is nested n levels]: the levels are the array, and the value.
    const chunked = 'd818 5f 41 81 41 00 ff';
    assert.equal(cborDepth(bytes(`83 ${chunked} 01 02`)), 3);
    assert.doesNotThrow(() => assertCborDepth(bytes(`82 ${chunked} ${rep('81', 63)}00`)));
    assert.throws(() => assertCborDepth(bytes(`82 ${chunked} ${rep('81', 64)}00`)), refusal('depth'));
  });

  test('the bytes after a byte string under tag 24 are read at their place in the outer bytes', () => {
    // [h'81 00' under tag 24, then a value that is nested n levels]: the levels are the array, and the value.
    assert.equal(cborDepth(bytes(`83 ${embedded('81 00')} 01 02`)), 3);
    assert.doesNotThrow(() => assertCborDepth(bytes(`82 ${embedded('00')} ${rep('81', 63)}00`)));
    assert.throws(() => assertCborDepth(bytes(`82 ${embedded('00')} ${rep('81', 64)}00`)), refusal('depth'));
  });

  test('chunks that join into a nested value are read: 64 levels with the tag are accepted, and 65 are refused', () => {
    for (const [levels, accepted] of [[63, true], [64, false]] as const) {
      // The value is joined from chunks of one byte each.
      const chunks = `${rep('81', levels)}00`.match(/../g)!.map((byte) => `41${byte}`).join('');
      if (accepted) assert.doesNotThrow(() => assertCborDepth(bytes(`d818 5f ${chunks} ff`)));
      else assert.throws(() => assertCborDepth(bytes(`d818 5f ${chunks} ff`)), refusal('depth'));
    }
  });

  test('a million chunks are joined in time', () => {
    const input = Buffer.concat([bytes('d818 5f'), Buffer.from(rep('4100', 1_000_000), 'hex'), bytes('ff')]);
    const started = performance.now();
    assert.equal(cborDepth(input), 1);
    assert.ok(performance.now() - started < 3000, `took ${performance.now() - started} ms`);
  });
});

describe('assertCborDepth: bytes that are not well-formed CBOR are refused', () => {
  const malformed: Array<[string, string]> = [
    ['no bytes', ''],
    ['a reserved additional information 28 on an integer', '1c'], ['a reserved additional information 29 on a negative integer', '3d'], ['a reserved additional information 30 on a byte string', '5e'],
    ['a reserved additional information on a text string', '7c'], ['a reserved additional information on an array', '9d'], ['a reserved additional information on a map', 'be'],
    ['a reserved additional information on a tag', 'dc'], ['a reserved additional information on a simple value', 'fc'], ['a reserved simple value 29', 'fd'], ['a reserved simple value 30', 'fe'],
    ['an indefinite length on an unsigned integer', '1f'], ['an indefinite length on a negative integer', '3f'], ['an indefinite length on a tag', 'df'],
    ['an integer cut in its header', '18'], ['an integer cut after one byte of two', '1900'], ['an integer cut in four bytes', '1a000000'], ['an integer cut in eight bytes', '1b00000000000000'],
    ['a simple value cut', 'f8'], ['a half float cut', 'f900'], ['a single float cut', 'fa000000'], ['a double float cut', 'fb0000000000'],
    ['a byte string without its bytes', '41'], ['a byte string that is one byte short', '4200'], ['a text string that is one byte short', '6261'],
    ['an array of two items with one', '8200'], ['an array of three items with two', '830000'], ['a map that ends after a key', 'a100'], ['a map of two pairs with three items', 'a2000000'],
    ['an indefinite-length array without its break', '9f00'], ['an indefinite-length map without its break', 'bf0000'], ['an indefinite-length array that ends at its opening', '9f'],
    ['an indefinite-length map that ends after a key', 'bf00ff'], ['an indefinite-length map that ends after three items', 'bf000000ff'],
    ['a break code alone', 'ff'], ['a break code in a definite array', '82 00 ff'], ['a break code in a tag', 'c1ff'], ['a break code in a definite map', 'a1 00 ff'],
    ['a tag without its item', 'c0'], ['a tag cut in its number', 'd8'],
    ['an indefinite-length byte string without its break', '5f4100'], ['an indefinite-length byte string alone', '5f'],
    ['an indefinite-length byte string with a text chunk', '5f6100ff'], ['an indefinite-length text string with a byte chunk', '7f4100ff'],
    ['an indefinite-length string in an indefinite-length string', '5f5fffff'], ['an indefinite-length string with an integer chunk', '5f00ff'],
    ['an indefinite-length string whose last chunk holds the break code', '5f4200ff'],
  ];
  for (const [description, hex] of malformed) {
    test(`${description}`, () => {
      assert.throws(() => assertCborDepth(bytes(hex)), refusal('format', /is not well-formed CBOR/));
    });
  }

  test('a length that the input declares and does not have is refused, for each type', () => {
    const past: Array<[string, string]> = [
      ['a byte string of 2^64 - 1 bytes', '5bffffffffffffffff'], ['a byte string of 2^32 bytes', '5b0000000100000000'], ['a byte string of 2^32 - 1 bytes', '5affffffff00'],
      ['a byte string of 256 bytes with one', '5a0000010000'], ['a text string of 2^64 - 1 bytes', '7bffffffffffffffff'], ['a text string of 2^32 - 1 bytes', '7affffffff00'],
      ['an array of 2^64 - 1 items', '9bffffffffffffffff'], ['an array of 2^32 - 1 items', '9affffffff00'], ['an array of 65535 items', '99ffff00'], ['an array of 255 items', '98ff00'],
      ['a map of 2^64 - 1 pairs', 'bbffffffffffffffff'], ['a map of 2^32 - 1 pairs', 'baffffffff00'], ['a map of 65535 pairs', 'b9ffff0000'],
      ['a chunk of 2^64 - 1 bytes', '5f5bffffffffffffffffff'],
    ];
    for (const [description, hex] of past) {
      assert.throws(() => assertCborDepth(bytes(hex)), refusal('format', /longer than the input|more items than the input/), description);
    }
  });

  test('a declared length is refused without a loop or an allocation for it', () => {
    const started = performance.now();
    for (let i = 0; i < 2000; i += 1) {
      assert.throws(() => assertCborDepth(bytes('9bffffffffffffffff')), refusal('format'));
      assert.throws(() => assertCborDepth(bytes('bbffffffffffffffff')), refusal('format'));
      assert.throws(() => assertCborDepth(bytes('5bffffffffffffffff')), refusal('format'));
    }
    assert.ok(performance.now() - started < 2000, `took ${performance.now() - started} ms`);
  });

  test('the bytes under tag 24 are a range of their own: a length past its end is refused although the input goes on', () => {
    // The byte string holds 3 bytes. The array in them declares 5 items, and the input holds more bytes after the byte string.
    assert.throws(() => assertCborDepth(bytes('d818 43 85 00 00 00 00 00 00')), refusal('format', /more items than the input/));
    assert.throws(() => assertCborDepth(bytes('d818 40')), refusal('format'));
    assert.throws(() => assertCborDepth(bytes('d818 43 ff ff ff')), refusal('format'));
    assert.throws(() => assertCborDepth(bytes('d818 58 05 00')), refusal('format', /longer than the input/));
    assert.throws(() => assertCborDepth(bytes('d818 5f ff')), refusal('format'), 'chunks without bytes');
    assert.throws(() => assertCborDepth(bytes('d818 5f 61 00 ff')), refusal('format'), 'a text chunk');
    assert.throws(() => assertCborDepth(bytes('d818 5f 41 85 41 00 ff')), refusal('format', /more items than the input/), 'chunks that join into an array with items missing');
    assert.throws(() => assertCborDepth(bytes('d818 5f 41 81 41 00')), refusal('format', /no break code/), 'chunks without a break code');
  });

  test('a depth is refused when a cut comes after it', () => {
    // The nesting is past the limit before the input ends in the middle of an item.
    assert.throws(() => assertCborDepth(bytes(rep('81', 100))), refusal('depth'));
    assert.throws(() => assertCborDepth(bytes(`${rep('9f', 100)}18`)), refusal('depth'));
  });
});

describe('assertCborDepth: the work is linear in the input and does not nest', () => {
  test('a wide array of 2 million items is read in time', () => {
    const items = 2_000_000;
    const input = Buffer.alloc(5 + items, 0);
    input.set(bytes('9a001e8480'), 0);
    const started = performance.now();
    assert.doesNotThrow(() => assertCborDepth(input));
    assert.ok(performance.now() - started < 3000, `took ${performance.now() - started} ms`);
  });

  test('a byte string and a text string of 64 MiB are skipped by their length', () => {
    const size = 64 * 1024 * 1024;
    const input = Buffer.alloc(9 + size, 0x41);
    input.set(bytes('5b'), 0);
    input.writeBigUInt64BE(BigInt(size), 1);
    const started = performance.now();
    assert.doesNotThrow(() => assertCborDepth(input));
    input.set(bytes('7b'), 0);
    assert.doesNotThrow(() => assertCborDepth(input));
    assert.ok(performance.now() - started < 1000, `took ${performance.now() - started} ms`);
  });

  test('a value that is wide and deep: 64 levels, each an array of 100,001 items', () => {
    const zeros = rep('00', 100_000);
    let value = `9a000186a0${zeros}`;
    for (let level = 1; level < 64; level += 1) value = `9a000186a1${value}${zeros}`;
    const started = performance.now();
    assert.equal(cborDepth(bytes(value)), 64);
    assert.doesNotThrow(() => assertCborDepth(bytes(value)));
    assert.ok(performance.now() - started < 3000, `took ${performance.now() - started} ms`);
  });

  test('500,000 small maps with arrays in them', () => {
    // One array of 500,000 items, each {0: [1, "a", h'01']}.
    const count = 500_000;
    const input = Buffer.concat([bytes(`9a${count.toString(16).padStart(8, '0')}`), Buffer.from(rep('a1 00 83 01 6161 4101'.replace(/\s+/g, ''), count), 'hex')]);
    const started = performance.now();
    assert.equal(cborDepth(input), 3);
    assert.ok(performance.now() - started < 3000, `took ${performance.now() - started} ms`);
  });
});

describe('assertCborHexDepth', () => {
  test('hex of either case is read, and a value at the limit is accepted', () => {
    assert.doesNotThrow(() => assertCborHexDepth('d87980'));
    assert.doesNotThrow(() => assertCborHexDepth('D87980'));
    assert.doesNotThrow(() => assertCborHexDepth(`${rep('81', 64)}00`));
  });

  test('nesting past the limit is refused, and the message names the value', () => {
    assert.throws(() => assertCborHexDepth(`${rep('81', 65)}00`, { what: 'The datum' }), refusal('depth', /^The datum is nested deeper than 64 levels\.$/));
  });

  test('a string that is not hex of whole bytes is refused', () => {
    for (const text of ['abc', 'zz', 'd87980 ', ' d87980', '0xd87980', 'd8\n79 80']) {
      assert.throws(() => assertCborHexDepth(text), refusal('format', /is not hex of whole bytes/), JSON.stringify(text));
    }
    assert.throws(() => assertCborHexDepth('xyz', { what: 'The datum' }), refusal('format', /^The datum is not hex of whole bytes\.$/));
  });

  test('a value that is not a string is refused', () => {
    for (const value of [undefined, null, 5, {}, []]) {
      assert.throws(() => assertCborHexDepth(value as unknown as string), refusal('format'), String(value));
    }
  });

  test('hex that is not CBOR is refused as not well-formed, also when it is empty', () => {
    assert.throws(() => assertCborHexDepth('ff'), refusal('format', /is not well-formed CBOR/));
    assert.throws(() => assertCborHexDepth('9f00'), refusal('format', /is not well-formed CBOR/));
    assert.throws(() => assertCborHexDepth(''), refusal('format', /is not well-formed CBOR/));
  });
});

describe('assertCborDepth: simple values and floats', () => {
  const holds = refusal('format', /holds a simple value or a float/);
  const hash28 = '00'.repeat(28);
  const credential = `82 00 581c${hash28}`;
  const txin = `82 5820${'22'.repeat(32)} 00`;
  /** A transaction with the given body, witness set and auxiliary data, as [body, witness set, is valid, auxiliary data]. */
  const transaction = (body: string, witness = 'a0', valid = 'f5', aux = 'f6'): Uint8Array => bytes(`84 ${body} ${witness} ${valid} ${aux}`);
  const asTransaction = { kind: 'transaction' } as const;

  test('a transaction may hold false, true and null as its third and fourth item', () => {
    assert.doesNotThrow(() => assertCborDepth(transaction('a0'), asTransaction));
    assert.doesNotThrow(() => assertCborDepth(transaction('a0', 'a0', 'f4'), asTransaction));
    assert.doesNotThrow(() => assertCborDepth(transaction('a0', 'a0', 'f5', 'a0'), asTransaction));
    assert.doesNotThrow(() => assertCborDepth(bytes('9f a0 a0 f5 f6 ff'), asTransaction), 'in an array without a declared count');
  });

  test('a transaction may hold null inside the certificates, the votes and the proposals of its body', () => {
    const poolRegistration = `8a 03 581c${hash28} 5820${'11'.repeat(32)} 1a000f4240 1a000f4240 d81e82 01 02 581de1${hash28} 81 581c${hash28} 81 84 00 f6 f6 f6 f6`;
    const drepRegistration = `84 10 ${credential} 1a0007a120 f6`;
    const body = (key: string, value: string): string => `a2 00 81 ${txin} ${key} ${value}`;
    assert.doesNotThrow(() => assertCborDepth(transaction(body('04', `81 ${poolRegistration}`)), asTransaction), 'a pool registration: relays and metadata');
    assert.doesNotThrow(() => assertCborDepth(transaction(body('04', `81 ${drepRegistration}`)), asTransaction), 'a DRep registration without an anchor');
    assert.doesNotThrow(() => assertCborDepth(transaction(body('13', `a1 82 00 581c${hash28} a1 82 5820${'33'.repeat(32)} 00 82 01 f6`)), asTransaction), 'a vote without an anchor');
    const proposal = `84 1a3b9aca00 581de1${hash28} 84 00 f6 a0 f6 82 6568747470 5820${'44'.repeat(32)}`;
    assert.doesNotThrow(() => assertCborDepth(transaction(body('14', `81 ${proposal}`)), asTransaction), 'a parameter change without a previous action or a policy');
  });

  test('a transaction holds no false, true or null in a list of its body, in its witness set or in its auxiliary data', () => {
    const list = (key: string, element: string): string => `a1 ${key} 81 ${element}`;
    // Each place builds a transaction with the value `v` in it.
    const places: Array<[string, (v: string) => Uint8Array]> = [
      ['an input', (v) => transaction(list('00', v))], ['an input in a tagged set', (v) => transaction(`a1 00 d90102 81 ${v}`)], ['an output', (v) => transaction(list('01', v))],
      ['a certificate', (v) => transaction(list('04', v))], ['a required signer', (v) => transaction(list('0e', v))], ['a collateral input', (v) => transaction(list('0d', v))],
      ['a reference input', (v) => transaction(list('12', v))], ['a proposal', (v) => transaction(list('14', v))], ['a key of the withdrawals', (v) => transaction(`a1 05 a1 ${v} 00`)],
      ['a key of the mint', (v) => transaction(`a1 09 a1 ${v} a0`)], ['a key of an output', (v) => transaction(`a1 01 81 a1 ${v} 00`)],
      ['a witness of a key', (v) => transaction('a0', list('00', v))], ['a native script of the witness set', (v) => transaction('a0', list('01', `82 01 81 ${v}`))],
      ['a datum of the witness set', (v) => transaction('a0', list('04', `82 00 ${v}`))], ['a datum in a tag of the witness set', (v) => transaction('a0', list('04', `d8799f ${v} ff`))],
      ['a redeemer of the witness set', (v) => transaction('a0', list('05', `84 00 00 82 00 ${v} 82 00 00`))],
      ['the auxiliary data', (v) => transaction('a0', 'a0', 'f5', `a1 00 81 ${v}`)], ['the auxiliary data, nested', (v) => transaction('a0', 'a0', 'f5', `a1 00 82 00 81 ${v}`)],
      ['the first item', (v) => bytes(`84 ${v} a0 f5 f6`)], ['the second item', (v) => bytes(`84 a0 ${v} f5 f6`)], ['a value that is not a transaction', (v) => bytes(`82 00 ${v}`)], ['a value alone', (v) => bytes(v)],
      ['the value of a map that is not a transaction', (v) => bytes(`a2 00 00 01 ${v}`)],
    ];
    for (const value of ['f4', 'f5', 'f6']) {
      for (const [description, build] of places) {
        assert.throws(() => assertCborDepth(build(value), asTransaction), holds, `${value} as ${description}`);
      }
    }
  });

  test('floats, undefined and the other simple values are refused in a transaction as well, also where false, true and null are not', () => {
    const values: Array<[string, string]> = [
      ['undefined', 'f7'], ['a simple value', 'f0'], ['a simple value of one byte', 'f820'],
      ['a half float', 'f90000'], ['a single float', 'fa00000000'], ['a double float', 'fb0000000000000000'],
    ];
    for (const [description, hex] of values) {
      assert.throws(() => assertCborDepth(transaction('a0', 'a0', hex), asTransaction), holds, `${description} as the third item`);
      assert.throws(() => assertCborDepth(transaction('a0', 'a0', 'f5', hex), asTransaction), holds, `${description} as the fourth item`);
      assert.throws(() => assertCborDepth(transaction(`a2 00 81 ${txin} 04 81 84 10 ${credential} 1a0007a120 ${hex}`), asTransaction), holds, `${description} in a certificate`);
      assert.throws(() => assertCborDepth(transaction(`a1 00 81 ${hex}`), asTransaction), holds, `${description} as an input`);
    }
  });

  test('Plutus data and metadata hold no simple value or float at all: false, true and null are refused as well, wherever they are', () => {
    const values: Array<[string, string]> = [
      ['false', 'f4'], ['true', 'f5'], ['null', 'f6'], ['undefined', 'f7'], ['a simple value', 'f0'], ['a simple value of one byte', 'f820'],
      ['a half float', 'f90000'], ['a single float', 'fa00000000'], ['a double float', 'fb0000000000000000'],
    ];
    for (const [description, hex] of values) {
      for (const place of ['%', '81%', '8200%', 'a100%', 'd8799f%ff', '9f%ff', 'bf00%ff', 'c1%']) {
        assert.throws(() => assertCborDepth(bytes(place.replace('%', hex))), holds, `${description} in ${place}`);
      }
    }
    assert.throws(() => assertCborHexDepth('f6'), holds);
    assert.doesNotThrow(() => assertCborDepth(bytes('d8799f01a1010281054401020304ff')));
  });

  test('false, true and null are refused as the key of a map, and in the bytes under tag 24, also in a transaction', () => {
    for (const hex of ['f4', 'f5', 'f6']) {
      assert.throws(() => assertCborDepth(bytes(`a1 ${hex} 00`), asTransaction), holds, 'the key of a map');
      assert.throws(() => assertCborDepth(bytes(`bf ${hex} 00 ff`), asTransaction), holds, 'the key of an indefinite-length map');
      assert.throws(() => assertCborDepth(bytes(`bf 00 00 ${hex} 00 ff`), asTransaction), holds, 'the second key of an indefinite-length map');
      // The datum of an output, as the body holds it: the bytes under tag 24 are Plutus data.
      const output = (datum: string): string => `a3 00 581d61${'11'.repeat(28)} 01 1a001e8480 02 82 01 ${embedded(datum)}`;
      assert.throws(() => assertCborDepth(transaction(`a1 01 81 ${output(hex)}`), asTransaction), holds, 'the datum of an output');
      assert.throws(() => assertCborDepth(transaction(`a1 01 81 ${output(`82 00 ${hex}`)}`), asTransaction), holds, 'inside the datum of an output');
      assert.throws(() => assertCborDepth(bytes(`d818 5f 41 ${hex} ff`), asTransaction), holds, 'under tag 24, in chunks');
      assert.doesNotThrow(() => assertCborDepth(transaction(`a1 01 81 ${output('d87980')}`), asTransaction), 'the same output with a datum that holds none');
    }
  });

  test('a measure reads them without refusing', () => {
    assert.equal(cborDepth(bytes('81 f6')), 1);
    assert.equal(cborDepth(bytes('a1 f6 f90000')), 1);
    assert.equal(cborDepth(bytes(embedded('f4'))), 1);
  });
});

describe('assertCborDepth: empty byte strings in a transaction', () => {
  const refused = refusal('format', /holds an empty byte string/);
  const hash28 = '00'.repeat(28);
  const address = `581d61${'11'.repeat(28)}`;
  const reward = `581de1${'11'.repeat(28)}`;
  const transaction = (body: string, witness = 'a0', aux = 'f6'): Uint8Array => bytes(`84 ${body} ${witness} f5 ${aux}`);
  const asTransaction = { kind: 'transaction' } as const;
  const EMPTY = ['40', '5f ff', '5f 40 ff', '5f 40 40 ff']; // an empty byte string, definite and in chunks

  test('an address, a hash or a reward account without bytes is refused where a body holds one', () => {
    const places: Array<[string, (e: string) => Uint8Array]> = [
      ['the address of an output', (e) => transaction(`a1 01 81 a2 00 ${e} 01 1a001e8480`)],
      ['the address of an output, in the form of a list', (e) => transaction(`a1 01 81 82 ${e} 1a001e8480`)],
      ['the address of the collateral return', (e) => transaction(`a1 10 a2 00 ${e} 01 1a001e8480`)],
      ['an account of the withdrawals', (e) => transaction(`a1 05 a1 ${e} 00`)],
      ['a policy of the mint', (e) => transaction(`a1 09 a1 ${e} a0`)],
      ['the reward account of a pool', (e) => transaction(`a1 04 81 8a 03 581c${hash28} 5820${'11'.repeat(32)} 1a000f4240 1a000f4240 d81e82 01 02 ${e} 81 581c${hash28} 80 f6`)],
      ['the reward account of a proposal', (e) => transaction(`a1 14 81 84 1a3b9aca00 ${e} 84 00 f6 a0 f6 82 6468747470 5820${'44'.repeat(32)}`)],
      ['a required signer', (e) => transaction(`a1 0e 81 ${e}`)],
      ['a hash of the body', (e) => transaction(`a1 07 ${e}`)],
      ['the body', (e) => bytes(`84 ${e} a0 f5 f6`)],
    ];
    for (const empty of EMPTY) {
      for (const [description, build] of places) assert.throws(() => assertCborDepth(build(empty), asTransaction), refused, `${empty} as ${description}`);
    }
  });

  test('an asset name without bytes is accepted, in an output, in a mint and in the collateral return', () => {
    const value = `82 1a001e8480 a1 581c${hash28} a1 40 05`;
    for (const empty of EMPTY) {
      const assets = `a1 581c${hash28} a1 ${empty} 05`;
      assert.doesNotThrow(() => assertCborDepth(transaction(`a1 01 81 a2 00 ${address} 01 82 1a001e8480 ${assets}`), asTransaction), `${empty} in an output`);
      assert.doesNotThrow(() => assertCborDepth(transaction(`a1 09 ${assets}`), asTransaction), `${empty} in a mint`);
      assert.doesNotThrow(() => assertCborDepth(transaction(`a1 10 a2 00 ${address} 01 82 1a001e8480 ${assets}`), asTransaction), `${empty} in the collateral return`);
    }
    assert.doesNotThrow(() => assertCborDepth(transaction(`a1 01 81 82 ${address} ${value}`), asTransaction), 'in an output in the form of a list');
  });

  test('an empty byte string is accepted outside the body, under tag 24 and in Plutus data', () => {
    const output = (datum: string): string => `a3 00 ${address} 01 1a001e8480 02 82 01 ${embedded(datum)}`;
    for (const empty of EMPTY) {
      assert.doesNotThrow(() => assertCborDepth(transaction('a0', `a1 04 81 ${empty}`), asTransaction), 'a datum of the witness set');
      assert.doesNotThrow(() => assertCborDepth(transaction('a0', `a1 02 81 84 5820${'11'.repeat(32)} 5840${'22'.repeat(64)} 5820${'33'.repeat(32)} ${empty}`), asTransaction), 'the attributes of a bootstrap witness');
      assert.doesNotThrow(() => assertCborDepth(transaction('a0', 'a0', `a1 00 ${empty}`), asTransaction), 'a metadatum');
      assert.doesNotThrow(() => assertCborDepth(transaction(`a1 01 81 ${output(`d8799f ${empty} ff`)}`), asTransaction), 'a datum of an output');
      assert.doesNotThrow(() => assertCborDepth(bytes(`d8799f ${empty} ff`)), 'Plutus data');
      assert.doesNotThrow(() => assertCborDepth(bytes(`a1 00 ${empty}`)), 'metadata');
    }
    assert.doesNotThrow(() => assertCborDepth(transaction(`a1 01 81 a2 00 ${address} 01 60`), asTransaction), 'an empty text string is not an empty byte string');
    assert.doesNotThrow(() => assertCborDepth(transaction(`a1 05 a1 ${reward} 00`), asTransaction), 'a reward account that holds bytes');
  });
});
