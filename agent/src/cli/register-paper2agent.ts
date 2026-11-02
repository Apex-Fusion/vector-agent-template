import { openSync, writeFileSync, fsyncSync, closeSync } from "node:fs";
import { parsePaper2AgentManifest, paper2AgentManifestHash, paper2AgentModel,
  PAPER2AGENT_CAPABILITY_ID, PAPER2AGENT_DELIVERY_OVERHEAD_MS, type Paper2AgentManifest } from "@marketplace/shared/paper2agent";
import { loadPaper2AgentConfig, type Paper2AgentConfig } from "../config.js";
import { LocalToolSession, configuredTool, packageSha256, type ToolSessionFactory } from "../paper2agent/local.js";

export interface RegisterToolOptions {
  config: Paper2AgentConfig;
  name: string;
  limits: Paper2AgentManifest["limits"];
  sessionFactory?: ToolSessionFactory;
}

/** Local inspection only. No wallet, provider, network install or chain calls. */
export async function registerPaper2Agent(options: RegisterToolOptions): Promise<Paper2AgentManifest> {
  const { config, name, limits } = options;
  const packageHash = await packageSha256(config.packagePath);
  const session = options.sessionFactory?.(config) ?? new LocalToolSession(config);
  let manifest: Paper2AgentManifest;
  try {
    const tool = configuredTool(await session.discover(), name);
    manifest = parsePaper2AgentManifest({ schema_version: 1, name: tool.name,
      description: tool.description ?? tool.name, package_sha256: packageHash,
      input_schema: tool.inputSchema, output_schema: tool.outputSchema, limits });
    if (await packageSha256(config.packagePath) !== packageHash) throw new Error("Prepared package changed during discovery");
  } finally { await session.close(); }
  // Refuse to replace a previously registered version by accident.
  const fd = openSync(config.manifestPath, "wx", 0o600);
  try { writeFileSync(fd, `${JSON.stringify(manifest, null, 2)}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
  return manifest;
}

export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const config = loadPaper2AgentConfig(env);
  const name = env.PAPER2AGENT_TOOL_NAME;
  if (!name) throw new Error("PAPER2AGENT_TOOL_NAME is required");
  const limits: Paper2AgentManifest["limits"] = {
    max_input_bytes: Number(env.PAPER2AGENT_MAX_INPUT_BYTES),
    max_output_bytes: Number(env.PAPER2AGENT_MAX_OUTPUT_BYTES),
    max_runtime_ms: Number(env.PAPER2AGENT_MAX_RUNTIME_MS),
  };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Explicit positive Paper2Agent byte and runtime limits are required");
  }
  const manifest = await registerPaper2Agent({ config, name, limits });
  process.stdout.write(`${JSON.stringify({ manifest_path: config.manifestPath,
    manifest_hash: paper2AgentManifestHash(manifest),
    post_advert_env: { CAPABILITY_KIND: "paper2agent", PAPER2AGENT_MANIFEST: config.manifestPath,
      ADVERT_CAPABILITY_ID: PAPER2AGENT_CAPABILITY_ID, ADVERT_MODEL: paper2AgentModel(manifest),
      ADVERT_MAX_OUTPUT_TOKENS: "0",
      ADVERT_MAX_PROCESSING_MS: String(manifest.limits.max_runtime_ms + PAPER2AGENT_DELIVERY_OVERHEAD_MS),
    },
  }, null, 2)}\n`);
}

if (process.argv[1]?.endsWith("register-paper2agent.ts") || process.argv[1]?.endsWith("register-paper2agent.js")) {
  main().catch(() => {
    process.stderr.write("Paper2Agent registration failed; check the local package, tool schemas, paths and limits.\n");
    process.exitCode = 1;
  });
}
