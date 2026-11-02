import { createHash } from "node:crypto";
import { createReadStream, openSync, fstatSync, readSync, closeSync, constants } from "node:fs";
import { Client, type Tool, type JsonSchemaType, type JsonSchemaValidator } from "@modelcontextprotocol/client";
import { canonicalize } from "@marketplace/shared/cbor";
import {
  parsePaper2AgentManifest, validatePaper2AgentOutput,
  MAX_TOOL_MANIFEST_BYTES, MAX_TOOL_INPUT_BYTES, MAX_TOOL_OUTPUT_BYTES, MAX_TOOL_RUNTIME_MS,
  type Paper2AgentManifest, type JsonObject,
} from "@marketplace/shared/paper2agent";
import type { Paper2AgentConfig } from "../config.js";
import { BoundedStdioTransport } from "./transport.js";

export const MCP_DISCOVERY_MS = 15000;

export function readManifest(path: string): Paper2AgentManifest {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_TOOL_MANIFEST_BYTES) throw new Error("Manifest file is too large or not a regular file");
    // Read through the checked descriptor, not a path that can change between checks.
    const bytes = Buffer.allocUnsafe(MAX_TOOL_MANIFEST_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_TOOL_MANIFEST_BYTES) throw new Error("Manifest file exceeds limit");
    return parsePaper2AgentManifest(JSON.parse(bytes.toString("utf8", 0, length)));
  } finally { closeSync(fd); }
}

export async function packageSha256(path: string): Promise<string> {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  if (!fstatSync(fd).isFile()) {
    closeSync(fd);
    throw new Error("Prepared package must be a regular file");
  }
  const hash = createHash("sha256");
  const stream = createReadStream(path, { fd, autoClose: true });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyPackage(config: Paper2AgentConfig, manifest: Paper2AgentManifest): Promise<void> {
  if (await packageSha256(config.packagePath) !== manifest.package_sha256) {
    throw new Error("Prepared package SHA-256 does not match the manifest");
  }
}

// The SDK also compiles schemas from tools/list. Apply the shared safety policy
// there, before any untrusted server schema reaches a validator compiler.
const safeSchemaValidator = {
  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    const manifest = parsePaper2AgentManifest({
      schema_version: 1, name: "schema_check", description: "Schema validation",
      package_sha256: "0".repeat(64), input_schema: { type: "object" }, output_schema: schema,
      limits: { max_input_bytes: MAX_TOOL_INPUT_BYTES, max_output_bytes: MAX_TOOL_OUTPUT_BYTES,
        max_runtime_ms: MAX_TOOL_RUNTIME_MS },
    });
    return (input) => {
      try {
        return { valid: true, data: validatePaper2AgentOutput(manifest, input) as T, errorMessage: undefined };
      } catch {
        return { valid: false, data: undefined, errorMessage: "Tool schema or data validation failed" };
      }
    };
  },
};

export interface ToolSession {
  discover(): Promise<Tool[]>;
  execute(name: string, input: JsonObject, timeoutMs: number): Promise<unknown>;
  close(): Promise<void>;
}
export type ToolSessionFactory = (config: Paper2AgentConfig) => ToolSession;

export class LocalToolSession implements ToolSession {
  private readonly transport: BoundedStdioTransport;
  private readonly client = new Client({ name: "vector-paper2agent", version: "1.0.0" }, {
    capabilities: {}, listMaxPages: 4, jsonSchemaValidator: safeSchemaValidator,
  });
  private connected = false;
  private used = false;

  constructor(config: Paper2AgentConfig) {
    this.transport = new BoundedStdioTransport(config);
  }

  async discover(): Promise<Tool[]> {
    const signal = AbortSignal.timeout(MCP_DISCOVERY_MS);
    await this.client.connect(this.transport, { timeout: MCP_DISCOVERY_MS, signal });
    this.connected = true;
    const result = await this.client.listTools(undefined, { timeout: MCP_DISCOVERY_MS, signal });
    if (result.tools.length > 128) throw new Error("MCP tool discovery limit exceeded");
    return result.tools;
  }

  async execute(name: string, input: JsonObject, timeoutMs: number): Promise<unknown> {
    if (!this.connected || this.used) throw new Error("MCP tool session is not available");
    this.used = true;
    const output = await this.client.callTool({ name, arguments: input }, {
      timeout: timeoutMs, maxTotalTimeout: timeoutMs, resetTimeoutOnProgress: false,
    });
    if (output.isError) throw new Error("MCP tool returned an error");
    // No files, resource reads, text-to-JSON fallbacks or downstream tool calls.
    if (!output.structuredContent || output.content?.some((item) => item.type !== "text")) {
      throw new Error("MCP tool must return inline structured JSON without resources");
    }
    return output.structuredContent;
  }

  async close(): Promise<void> {
    // Transport close waits for process termination; SDK close alone need not.
    await this.transport.close();
    await this.client.close();
  }
}

export function configuredTool(tools: Tool[], name: string): Tool {
  const matches = tools.filter((tool) => tool.name === name);
  if (matches.length !== 1 || !matches[0].outputSchema) {
    throw new Error("Configured MCP tool must be unique and declare an output schema");
  }
  return matches[0];
}

export function checkTool(manifest: Paper2AgentManifest, tools: Tool[]): void {
  const tool = configuredTool(tools, manifest.name);
  const discovered = parsePaper2AgentManifest({ ...manifest,
    input_schema: tool.inputSchema, output_schema: tool.outputSchema });
  if (canonicalize(discovered.input_schema) !== canonicalize(manifest.input_schema) ||
      canonicalize(discovered.output_schema) !== canonicalize(manifest.output_schema)) {
    throw new Error("Configured MCP tool schemas do not match the manifest");
  }
}
