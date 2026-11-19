/**
 * agent/src/routes/customCard.ts — the agent card and GET /.
 *
 * With PUBLIC_ORIGIN set, the runtime serves two more routes:
 *
 *   GET /.well-known/agent-card.json   the agent card (A2A), one interface:
 *                                      <PUBLIC_ORIGIN>/v1/job
 *   GET /                              a small JSON page with the status 200
 *
 * Why: the identity gateway lists an agent in its catalogs only when the
 * endpoint of the record serves a valid card with an interface on the same
 * https origin. A 2xx on GET / alone gives no catalog entry.
 *
 * Without PUBLIC_ORIGIN the runtime mounts neither route, and both answer 404
 * as before. No valid card is possible then: the card needs an https interface
 * on the origin of the record endpoint, and the runtime does not guess it. The
 * origin comes from the setting only, never from a header of the request.
 *
 * The card must be live before the record is registered, because the gateway
 * checks the card when it sees the record. So the card needs no data from the
 * chain. It takes the capability and the model of the advert when the runtime
 * can read the advert, and it has no skill when it cannot. The runtime reads
 * the advert at most once in ADVERT_CACHE_MS.
 */

import type { Application, Request, Response, NextFunction } from "express";

import type { ChainProvider, OutputReference } from "@marketplace/shared/chain";

import { decodeAdvert } from "../identity/agent.js";

export const CARD_PATH = "/.well-known/agent-card.json";
/** The job route that the card names. */
export const JOB_PATH = "/v1/job";
/** The binding and the version that the card gives its interface. */
export const JOB_BINDING = "vector-job-v1";
export const JOB_BINDING_VERSION = "1";

/** The gateway keeps an interface URL only when it is at most 512 bytes. */
const INTERFACE_URL_LIMIT_BYTES = 512;
/** The most characters of the model and of the capability id on the card. */
const TEXT_LIMIT = 256;
/** How long the runtime keeps what it read of the advert. */
const ADVERT_CACHE_MS = 30_000;

export interface AdvertText {
  capabilityId: string;
  model: string;
}

export interface AgentCard {
  name: string;
  description: string;
  version: string;
  capabilities: Record<string, never>;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: Array<{ id: string; name: string }>;
  supportedInterfaces: Array<{ url: string; protocolBinding: string; protocolVersion: string }>;
}

/**
 * PUBLIC_ORIGIN as the origin of its URL: an https URL with no user name, no
 * password, no path, no query and no fragment. The origin is what the gateway
 * compares with the interface of the card (the origin of the record endpoint).
 * Throws an Error that names the setting.
 */
export function parsePublicOrigin(value: string): string {
  const refuse = (why: string): Error => new Error(`loadConfig: PUBLIC_ORIGIN ${why}`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw refuse("must be an https origin, for example https://agent.example.com");
  }
  if (url.protocol !== "https:") throw refuse("must be an https origin: the gateway lists only https endpoints");
  if (url.username !== "" || url.password !== "") throw refuse("must have no user name and no password");
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw refuse("must be an origin only, with no path, no query and no fragment");
  }
  if (Buffer.byteLength(`${url.origin}${JOB_PATH}`, "utf8") > INTERFACE_URL_LIMIT_BYTES) {
    throw refuse(`is too long: the interface URL must have at most ${INTERFACE_URL_LIMIT_BYTES} bytes`);
  }
  return url.origin;
}

const cut = (text: string): string => text.slice(0, TEXT_LIMIT);

/** The card for `origin`. `advert` is null when the runtime cannot read the advert. */
export function buildAgentCard(origin: string, advert: AdvertText | null): AgentCard {
  const capabilityId = advert === null ? "" : cut(advert.capabilityId);
  const model = advert === null ? "" : cut(advert.model);
  return {
    name: model !== "" ? model : "Vector agent",
    description: capabilityId !== ""
      ? `Offers ${capabilityId} on the Vector agents marketplace. Post an escrow, then send the job to ${origin}${JOB_PATH}.`
      : `An agent on the Vector agents marketplace. Post an escrow, then send the job to ${origin}${JOB_PATH}.`,
    version: "1",
    capabilities: {},
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: capabilityId !== "" ? [{ id: capabilityId, name: capabilityId }] : [],
    supportedInterfaces: [{ url: `${origin}${JOB_PATH}`, protocolBinding: JOB_BINDING, protocolVersion: JOB_BINDING_VERSION }],
  };
}

export interface AgentCardDeps {
  chain: ChainProvider;
  config: { publicOrigin: string; advertRef: OutputReference };
  /** The clock of the cache of the advert text. Default: Date.now. */
  now?: () => number;
}

/** The capability and the model of the advert, or null. It never throws. */
async function readAdvertText(chain: ChainProvider, advertRef: OutputReference): Promise<AdvertText | null> {
  try {
    const utxo = await chain.queryUtxo(advertRef);
    if (utxo === null || !utxo.datumHex) return null;
    const { datum } = decodeAdvert(utxo.datumHex);
    return { capabilityId: datum.capability_id, model: datum.model };
  } catch {
    return null;
  }
}

/**
 * Mounts the two routes when `config.publicOrigin` is set, and nothing when it
 * is empty. Call it for the custom capability only.
 */
export function mountAgentCard(app: Application, deps: AgentCardDeps): void {
  const origin = deps.config.publicOrigin;
  if (!origin) return;
  const now = deps.now ?? Date.now;
  let cached: { at: number; advert: AdvertText | null } | undefined;
  const advertText = async (): Promise<AdvertText | null> => {
    if (cached !== undefined && now() - cached.at < ADVERT_CACHE_MS) return cached.advert;
    const advert = await readAdvertText(deps.chain, deps.config.advertRef);
    cached = { at: now(), advert };
    return advert;
  };

  app.get("/", (_req: Request, res: Response) => {
    res.status(200).json({ ok: true, agent_card: `${origin}${CARD_PATH}` });
  });
  app.get(CARD_PATH, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(200).json(buildAgentCard(origin, await advertText()));
    } catch (err) {
      next(err);
    }
  });
}
