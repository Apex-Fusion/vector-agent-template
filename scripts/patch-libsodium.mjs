// scripts/patch-libsodium.mjs - run by `postinstall` after every `pnpm install`, and by CI.
//
// libsodium-wrappers-sumo (transitive via @lucid-evolution/lucid) imports "./libsodium-sumo.mjs"
// from its own dist folder, but pnpm's strict store layout puts that file in the sibling package
// libsodium-sumo. Without it lucid does not load, and every command that builds a transaction
// (post-advert, retire-advert, try-it's buy-once, the agent's claim and submit) stops with
// "Cannot find module ... libsodium-sumo.mjs". agent/Dockerfile (vendored) makes the same copy in
// the image; this script makes it for a local install and for the tests.
//
// For each libsodium-wrappers-sumo@<version> in node_modules/.pnpm it copies
// libsodium-sumo@<version>/.../modules-sumo-esm/libsodium-sumo.mjs next to the wrapper. It is
// idempotent (an identical file is left alone) and it fails loudly when a source or a destination
// is not where pnpm puts it. It touches nothing outside node_modules.
import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const store = join(root, "node_modules", ".pnpm");
const WRAPPER = "libsodium-wrappers-sumo@";
const ESM = join("dist", "modules-sumo-esm");

function fail(message) {
  process.stderr.write(`patch-libsodium: ${message}\n`);
  process.exit(1);
}

if (!existsSync(store)) fail(`${store} not found: install with pnpm first`);
const wrappers = readdirSync(store).filter((name) => name.startsWith(WRAPPER));
if (wrappers.length === 0) fail(`no ${WRAPPER}* in ${store}`);

for (const name of wrappers) {
  const version = name.slice(WRAPPER.length);
  const dst = join(store, name, "node_modules", "libsodium-wrappers-sumo", ESM);
  const src = join(store, `libsodium-sumo@${version}`, "node_modules", "libsodium-sumo", ESM, "libsodium-sumo.mjs");
  if (!existsSync(dst)) fail(`destination not found: ${dst}`);
  if (!existsSync(src)) fail(`source not found: ${src}`);
  const target = join(dst, "libsodium-sumo.mjs");
  if (existsSync(target) && readFileSync(target).equals(readFileSync(src))) {
    process.stdout.write(`patch-libsodium: libsodium-wrappers-sumo ${version} already patched\n`);
    continue;
  }
  copyFileSync(src, target);
  process.stdout.write(`patch-libsodium: patched libsodium-wrappers-sumo ${version}\n`);
}
