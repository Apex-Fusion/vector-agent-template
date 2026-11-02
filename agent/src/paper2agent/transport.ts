import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { deserializeMessage, serializeMessage, type JSONRPCMessage, type Transport } from "@modelcontextprotocol/client";
import { MAX_TOOL_JSON_DEPTH } from "@marketplace/shared/paper2agent";
import type { Paper2AgentConfig } from "../config.js";

export const MCP_FRAME_BYTES = 786432;
export const MCP_STDERR_BYTES = 65536;
/**
 * Bracket ceiling for one received frame. Shared depth counts from zero at a
 * manifest or a tool result. The deepest valid frame is tools/list: message,
 * result, tools and tool enclose a schema that is already at manifest depth 1.
 */
export const MCP_JSON_DEPTH = MAX_TOOL_JSON_DEPTH + 4;
const MCP_TOTAL_BYTES = 4 * MCP_FRAME_BYTES;

/** Reject deeply nested wire JSON before the SDK's recursive message parsing. */
function boundedJsonDepth(text: string): void {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const ch of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === "{" || ch === "[") {
      if (++depth > MCP_JSON_DEPTH) throw new Error("MCP JSON nesting limit exceeded");
    } else if (ch === "}" || ch === "]") depth--;
  }
}

/** SDK protocol engine, with a host-controlled, bounded process transport. */
export class BoundedStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child?: ChildProcessWithoutNullStreams;
  private buffer = Buffer.allocUnsafe(MCP_FRAME_BYTES);
  private used = 0;
  private total = 0;
  private stderrBytes = 0;
  private stopped = false;
  private closing?: Promise<void>;
  private exited?: Promise<void>;

  constructor(private readonly config: Pick<Paper2AgentConfig, "executable" | "argv" | "cwd">) {}

  async start(): Promise<void> {
    if (this.child || this.stopped) throw new Error("MCP transport already started or closed");
    const child = spawn(this.config.executable, this.config.argv, {
      cwd: this.config.cwd,
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      // Do not copy process.env. In particular omit HOME, credentials, NODE_OPTIONS,
      // provider configuration, and buyer/wallet keys.
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: this.config.cwd },
    });
    this.child = child;
    this.exited = new Promise<void>((resolve) => {
      child.once("exit", () => { resolve(); this.onclose?.(); });
      child.once("error", () => resolve());
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.stopped) return;
      try { this.consume(chunk); } catch (error) { this.fail(error); }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      // Count and discard; never accumulate diagnostics or send them to the buyer.
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > MCP_STDERR_BYTES) this.fail(new Error("MCP stderr limit exceeded"));
    });
    child.stdin.on("error", (error) => this.fail(error));
    child.stdout.on("error", (error) => this.fail(error));
    child.stderr.on("error", (error) => this.fail(error));
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }

  private consume(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.total > MCP_TOTAL_BYTES) throw new Error("MCP total output limit exceeded");
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const size = end - offset;
      if (this.used + size > MCP_FRAME_BYTES) throw new Error("MCP frame limit exceeded");
      chunk.copy(this.buffer, this.used, offset, end);
      this.used += size;
      if (newline < 0) break;
      const line = this.buffer.toString("utf8", 0, this.used);
      this.used = 0;
      boundedJsonDepth(line);
      this.onmessage?.(deserializeMessage(line));
      offset = newline + 1;
      if (this.stopped) break;
    }
  }

  private fail(error: unknown): void {
    if (this.stopped) return;
    this.onerror?.(error instanceof Error ? error : new Error("MCP transport failure"));
    void this.close().catch(() => undefined);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.child || this.stopped) throw new Error("MCP transport is closed");
    const line = serializeMessage(message);
    if (Buffer.byteLength(line) > MCP_FRAME_BYTES) throw new Error("MCP outgoing frame limit exceeded");
    await new Promise<void>((resolve, reject) => {
      this.child!.stdin.write(line, (error) => error ? reject(error) : resolve());
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.closing = this.stop();
    return this.closing;
  }

  private async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); }
      catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") throw error;
      }
    };
    child.stdin.destroy();
    signalGroup("SIGTERM");
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([this.exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, 1000); })]);
    } finally { clearTimeout(timer); }
    // Also stop descendants if the direct child already exited.
    signalGroup("SIGKILL");
    try {
      await Promise.race([this.exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("MCP child did not exit after SIGKILL")), 1000);
      })]);
      clearTimeout(timer);
      const deadline = Date.now() + 1000;
      while (child.pid) {
        try { process.kill(-child.pid, 0); }
        catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") break;
          throw error;
        }
        if (Date.now() >= deadline) throw new Error("MCP process group did not terminate");
        await new Promise<void>((resolve) => { timer = setTimeout(resolve, 20); });
      }
    } finally {
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      this.used = 0;
    }
  }
}
