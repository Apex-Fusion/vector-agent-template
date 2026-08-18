/**
 * Plutus Tag extension for cbor-x.
 *
 * cbor-x's built-in Tag constructor is `new Tag(value, tagNumber)`, i.e.
 *   .value = payload, .tag = tagNumber.
 * Plutus convention (and the apex-dashboard codebase) uses the INVERSE:
 *   new Tag(tagNumber, fieldsArray) → .value = tagNumber, .tag = fieldsArray.
 *
 * To make the Plutus-convention work with cbor-x's encoder, we install an
 * extension that inspects each Tag instance during encode and picks the
 * correct (tag, payload) pair. Decode is not affected — cbor-x always
 * produces the standard shape when decoding.
 *
 * Registration is idempotent-ish: cbor-x accepts multiple addExtension calls
 * for the same Class, but the last registered extension wins. All callers
 * register an identical extension, so net behaviour is stable.
 */

import { Tag, addExtension } from "cbor-x";

let registered = false;

export function registerPlutusTagExtension(): void {
  if (registered) return;
  addExtension({
    Class: Tag,
    tag: undefined as unknown as number, // dynamic tag via getTag
    encode(tag: Tag, encodeFn: (data: unknown) => Uint8Array): Uint8Array {
      // Plutus convention: .value = numeric tag, .tag = payload array.
      if (typeof tag.value === "number" && Array.isArray(tag.tag)) {
        return encodeFn(tag.tag);
      }
      // Fallback: standard cbor-x convention.
      return encodeFn(tag.value);
    },
    getTag(tag: Tag): number {
      if (typeof tag.value === "number" && Array.isArray(tag.tag)) {
        return tag.value;
      }
      return tag.tag as number;
    },
  } as unknown as Parameters<typeof addExtension>[0]);
  registered = true;
}

/** Construct a Plutus-convention Tag instance (tagNumber, fieldsArray). */
export function plutusTag(tagNumber: number, fields: unknown): Tag {
  return new (Tag as unknown as new (a: unknown, b: unknown) => Tag)(
    tagNumber,
    fields,
  );
}
