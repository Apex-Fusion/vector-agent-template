# syntax=docker/dockerfile:1.7
#
# supplier/Dockerfile — multi-stage image for the supplier node.
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
#   docker build -f supplier/Dockerfile -t marketplace-supplier .
#
# Base image: node:20-alpine. Supplier has no native compile dependencies
# (@noble/ed25519, express, cbor-x are pure JS). Stay on alpine for size.

ARG NODE_VERSION=20.19.0

# ─── builder ──────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /repo

# pnpm via corepack — lockfile pins pnpm@10.33.2.
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

# Workspace manifests first to maximise layer cache reuse.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json .npmrc ./
# pnpm-lock.yaml's patchedDependencies hash the patch files at install time.
COPY patches ./patches
COPY packages/shared/package.json ./packages/shared/package.json
COPY supplier/package.json ./supplier/package.json
# Buyer + indexer manifests are needed because pnpm-lock.yaml indexes the
# whole workspace. They are referenced but not installed (--filter excludes).
COPY buyer/package.json ./buyer/package.json
COPY indexer/package.json ./indexer/package.json

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

# Copy the actual source — shared + supplier + Aiken blueprint (loadBlueprint
# reads contracts/marketplace/plutus.json at runtime to derive escrow addr +
# attach the spending validator script in M1-F-4 live-CBOR builders).
COPY packages/shared ./packages/shared
COPY supplier ./supplier
COPY contracts/marketplace/plutus.json ./contracts/marketplace/plutus.json

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
CMD ["node_modules/.bin/tsx", "supplier/src/index.ts"]
