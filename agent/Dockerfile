# syntax=docker/dockerfile:1.7
#
# agent/Dockerfile — multi-stage image for the supplier node.
#
# Strategy: install workspace deps in a builder stage, then ship the source
# tree + node_modules to a slim runtime stage that runs the entry point with
# tsx. We do NOT compile TypeScript ahead-of-time because @marketplace/shared
# exports .ts files via package.json#exports (`"./chain": "./src/chain/index.ts"`),
# which means a `tsc`-compiled `dist/index.js` cannot resolve those imports
# at runtime without an additional build step on the shared package. Running
# tsx is what apex-dashboard does and matches that working pattern.
#
# Build context MUST be the repo root so pnpm can resolve workspace deps:
#   docker build -f agent/Dockerfile -t marketplace-supplier .
#
# Base image: node:22-alpine, matching this repo's engines field (node >=22)
# and the Node version CI runs. Supplier has no native compile dependencies
# (@noble/ed25519, express, cbor-x are pure JS). Stay on alpine for size.

ARG NODE_VERSION=22.23.2

# ─── builder ──────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /repo

# pnpm via corepack — lockfile pins pnpm@10.33.2.
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

# Workspace manifests first to maximise layer cache reuse. This template
# vendors only packages/shared + agent (ex-supplier) — no root .npmrc, no
# patches/ dir (pnpm-lock.yaml here has no patchedDependencies), and no
# buyer/ or indexer/ siblings (this workspace's lockfile importers are only
# ".", "agent", "packages/shared" — confirmed via pnpm-lock.yaml), unlike the
# full upstream monorepo this Dockerfile was vendored from. Omitted rather
# than COPYing paths that don't exist in this repo.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY agent/package.json ./agent/package.json

# Install only what supplier needs (and its transitive workspace deps).
RUN pnpm install --frozen-lockfile --filter '@marketplace/supplier...'

# libsodium-wrappers-sumo (transitive via @lucid-evolution/lucid → CML) does
# `import "./libsodium-sumo.mjs"` from its wrapper, but pnpm's strict store
# layout puts the .mjs in a sibling pkg, breaking the relative import. Patch
# by copying the file into the wrapper's expected path. ARCHITECTURE.md §9 #16.
RUN set -e \
 && SRC=$(find node_modules/.pnpm -name "libsodium-sumo.mjs" -path "*/libsodium-sumo/dist/*" 2>/dev/null | head -1) \
 && DST=$(find node_modules/.pnpm -type d -path "*libsodium-wrappers-sumo@*/node_modules/libsodium-wrappers-sumo/dist/modules-sumo-esm" 2>/dev/null | head -1) \
 && [ -n "$SRC" ] && [ -n "$DST" ] || (echo "FATAL: libsodium-sumo paths not resolved" && exit 1) \
 && cp "$SRC" "$DST/" \
 && echo "patched libsodium wrapper: $DST/libsodium-sumo.mjs"

# Copy the actual source — shared + agent + the Aiken blueprint.
#
# The blueprint (contracts/marketplace/plutus.json) IS vendored into this
# template, pinned to the same upstream commit as the code (VENDORED-FROM.md).
# loadBlueprint() reads it to derive the escrow/advert script addresses and to
# attach the spending validator in the live-CBOR builders. It is loaded lazily,
# inside those builders (buildClaimTx/buildSubmitTx/postEscrow et al.), never at
# import or boot time — so an image missing it still builds and boots, then
# fails on the first real job, after the buyer's funds are already locked. That
# is exactly why it is copied here and checked in CI rather than left implicit.
#
# examples/ carries the demo black box (echo-service.mjs) the quickstart and
# deploy/docker-compose.yml run as a second service off this same image.
COPY packages/shared ./packages/shared
COPY agent ./agent
COPY contracts/marketplace/plutus.json ./contracts/marketplace/plutus.json
COPY examples ./examples

# Defence-in-depth against a leaked HOST node_modules: on at least one
# Docker Desktop + Windows-host combination, the two source COPYs above were
# observed to pull in a locally-installed agent/node_modules or
# packages/shared/node_modules from the build context DESPITE the root
# .dockerignore listing "node_modules" — reproduced with a full
# `docker builder prune -af` in between, so it was not a stale-cache
# artifact. COPY MERGES into an already-existing destination directory
# rather than replacing it, so this silently overlaid the correct,
# container-native node_modules the `pnpm install` above already produced
# with the host's own copy — which carries host-OS-specific pnpm symlinks
# (e.g. absolute Windows paths) that do not resolve inside this Linux image,
# breaking module resolution at runtime even though the build itself still
# exits 0. Fix: wipe whatever the COPYs may have overlaid, then re-run the
# SAME install command — idempotent and near-instant here since every
# package is already resolved into the local store from the first run — so
# the final node_modules is deterministically the correct, freshly-linked
# one regardless of what the build context happened to contain.
RUN rm -rf ./agent/node_modules ./packages/shared/node_modules \
 && pnpm install --frozen-lockfile --filter '@marketplace/supplier...'

# ─── runtime ──────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /repo

# tini for signal-forwarding (graceful SIGTERM → process.exit). wget for
# healthcheck (alpine has busybox wget by default).
RUN apk add --no-cache tini

# Copy installed node_modules + source from builder.
COPY --from=builder /repo /repo

# Drop privileges. The official node image ships a non-root `node` user.
RUN chown -R node:node /repo
USER node

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Healthcheck — supplier exposes /healthz (standardized 2026-04-27 across all
# services — see ARCHITECTURE.md §5). /healthz is a stateless 200-{ok:true}
# probe that NEVER touches chain or supplier state. /status remains as a
# separate route reporting free/working/offline marketplace state.
HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz >/dev/null || exit 1

# tsx is hoisted to /repo/node_modules/.bin by pnpm — invoke via the workspace bin.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "agent/src/index.ts"]
