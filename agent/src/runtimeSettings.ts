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
 */

export interface RuntimeSettings {
  /** SERVICE_PRECHECK_URL. Empty: no check before the Claim. */
  servicePrecheckUrl: string;
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

/** `custom` is true for CAPABILITY_KIND=custom. */
export function loadRuntimeSettings(env: Record<string, string | undefined>, custom: boolean): RuntimeSettings {
  const precheck = env.SERVICE_PRECHECK_URL;
  return {
    servicePrecheckUrl: custom && precheck !== undefined && precheck !== ""
      ? parseServiceUrl("SERVICE_PRECHECK_URL", precheck)
      : "",
  };
}
