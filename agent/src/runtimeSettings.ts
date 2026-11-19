/**
 * agent/src/runtimeSettings.ts — the settings that the template adds to the runtime.
 *
 * config.ts (vendored, with a patch) calls `loadRuntimeSettings` once and adds
 * the result to SupplierConfig. The settings are for the `custom` capability. For
 * another capability kind the function reads nothing, so a bad value in a shared
 * .env does not stop the boot of that kind.
 *
 *   SERVICE_PRECHECK_URL  The URL of the check before the Claim. Empty or unset:
 *                         there is no check.
 *   PUBLIC_ORIGIN         The https origin at which buyers and the identity
 *                         gateway reach this runtime. It is the origin of the
 *                         endpoint in the agent record. With it, the runtime
 *                         serves the agent card and a 200 on GET /. Empty or
 *                         unset: it serves neither.
 *   RELEASE_WATCHER       "1" starts the release watcher (releaseWatcher.ts). It
 *                         needs LIVE_CHAIN=1. Unset, empty or "0": it is off. Any
 *                         other value stops the boot, so that a typo does not
 *                         leave the watcher off without a word.
 */

import { parsePublicOrigin } from "./routes/customCard.js";

export interface RuntimeSettings {
  /** SERVICE_PRECHECK_URL. Empty: no check before the Claim. */
  servicePrecheckUrl: string;
  /** PUBLIC_ORIGIN, as the origin of its URL. Empty: no agent card. */
  publicOrigin: string;
  /** RELEASE_WATCHER=1. False: no release watcher. */
  releaseWatcher: boolean;
}

/** An http or https URL with no user name and no password. Throws an Error that names the setting. */
function parseServiceUrl(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`loadConfig: ${name} must be an http or https URL`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
    throw new Error(`loadConfig: ${name} must be an http or https URL with no user name and no password`);
  }
  return value;
}

/** A setting that is set: not undefined and not empty. */
const isSet = (value: string | undefined): value is string => value !== undefined && value !== "";

/** RELEASE_WATCHER: "1" is on, unset, empty and "0" are off, and any other value throws. */
function parseReleaseWatcher(env: Record<string, string | undefined>): boolean {
  const value = env.RELEASE_WATCHER;
  if (!isSet(value) || value === "0") return false;
  if (value !== "1") throw new Error('loadConfig: RELEASE_WATCHER must be "1" or "0"');
  if (env.LIVE_CHAIN !== "1") {
    throw new Error("loadConfig: RELEASE_WATCHER=1 needs LIVE_CHAIN=1, because a Release is a transaction");
  }
  return true;
}

/** `custom` is true for CAPABILITY_KIND=custom. */
export function loadRuntimeSettings(env: Record<string, string | undefined>, custom: boolean): RuntimeSettings {
  const precheck = env.SERVICE_PRECHECK_URL;
  const origin = env.PUBLIC_ORIGIN;
  return {
    servicePrecheckUrl: custom && isSet(precheck) ? parseServiceUrl("SERVICE_PRECHECK_URL", precheck) : "",
    publicOrigin: custom && isSet(origin) ? parsePublicOrigin(origin) : "",
    releaseWatcher: custom ? parseReleaseWatcher(env) : false,
  };
}
