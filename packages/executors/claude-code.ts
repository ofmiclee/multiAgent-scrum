import { spawn, execFile, type ChildProcessByStdio } from "node:child_process";
import { isAbsolute } from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { ExecutionInput, ExecutionResult, Executor } from "../domain/contracts.ts";
import { ExecutorStopUnconfirmed } from "../domain/execution-errors.ts";

export type ClaudeCodeAccount =
  | { type: "anthropic"; email: string }
  | { type: "apiKey" };
export type Options = {
  command?: string;
  timeoutMs?: number;
  model?: string;
  permissionMode?: "auto" | "manual" | "default" | "acceptEdits" | "dontAsk" | "plan" | "bypassPermissions";
};
type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\x00-\x20\x7f]/.test(value);
const MAX_LINE = 16 * 1024 * 1024;
const MAX_OUTPUT = 64 * 1024 * 1024;

// Keep the member's native login, but never inherit database/service secrets or
// Node injection settings. This experimental adapter does not provision accounts.
function harnessEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH", "HOME", "CLAUDE_CONFIG_DIR", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL",
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL",
  ]) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

/** Single-prompt stream-json transport. A result is provisional until exit. */
class ClaudeProcess {
  private child: ChildProcessByStdio<null, Readable, Readable>;
  private closed = false;
  private stopping = false;
  private failure?: Error;
  private sessionId?: string;
  private result?: ExecutionResult;
  private rejectCompletion!: (error: Error) => void;
  private resolveCompletion!: (result: ExecutionResult) => void;
  private closePromise: Promise<void>;
  readonly completion: Promise<ExecutionResult>;

  constructor(options: Options, input: ExecutionInput, prompt: string, assessment: boolean) {
    this.completion = new Promise((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    void this.completion.catch(() => {});
    // These recent CLI flags fail closed on older versions. Restricted mode
    // confines file tools to cwd; safe mode disables user/project customizations.
    // Admin-managed policy (including managed hooks) still applies.
    // No shell/code tools or MCP servers are exposed by this preview adapter.
    const args = [
      "--print", "--output-format", "stream-json", "--verbose",
      "--safe-mode", "--restricted", "--strict-mcp-config",
      "--permission-prompts", "none",
      "--permission-mode", assessment ? "dontAsk" : options.permissionMode ?? "dontAsk",
      "--tools", assessment ? "" : "Read,Glob,Grep,Edit,Write",
    ];
    const model = input.model ?? options.model;
    if (model) args.push("--model", model);
    args.push("--", prompt);
    this.child = spawn(options.command ?? "claude", args, {
      cwd: input.cwd,
      env: harnessEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    this.closePromise = new Promise(resolve => this.child.once("close", (code, signal) => {
      this.closed = true;
      if (!this.stopping && !this.failure) {
        if (signal || code !== 0)
          this.fail(new Error(`Claude Code exited with ${signal ? `signal ${signal}` : `code ${code}`} before completion`));
        else if (!this.result) this.fail(new Error("Claude Code exited without a result"));
        else this.resolveCompletion(this.result);
      }
      resolve();
    }));
    this.child.once("error", () => this.fail(new Error("Claude Code process could not start")));
    this.child.stdout.on("error", () => this.fail(new Error("Claude Code output stream failed")));
    this.child.stderr.on("error", () => this.fail(new Error("Claude Code diagnostic stream failed")));
    this.child.stderr.resume(); // Raw diagnostics can contain private paths or credentials.

    let buffer = "";
    let total = 0;
    const frame = (line: string) => {
      if (!line.trim() || this.stopping || this.failure) return;
      if (Buffer.byteLength(line) > MAX_LINE)
        return this.fail(new Error("Claude Code output exceeded adapter limit"));
      let value: unknown;
      try { value = JSON.parse(line); }
      catch { return this.fail(new Error("Claude Code returned invalid JSON protocol data")); }
      this.receive(value);
    };
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      if (this.stopping || this.failure) return;
      total += Buffer.byteLength(chunk);
      if (total > MAX_OUTPUT) return this.fail(new Error("Claude Code output exceeded adapter limit"));
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        frame(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (this.failure) return;
      }
      if (Buffer.byteLength(buffer) > MAX_LINE)
        this.fail(new Error("Claude Code output exceeded adapter limit"));
    });
    // stdout normally ends before the child's close event; flush its final frame.
    this.child.stdout.on("end", () => { frame(buffer); buffer = ""; });
  }

  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.rejectCompletion(error);
  }

  private receive(event: unknown): void {
    if (!isObject(event) || typeof event.type !== "string")
      return this.fail(new Error("Claude Code returned invalid protocol envelope"));
    if (event.type === "control_request")
      return this.fail(new Error("Claude Code unsupported human input or approval request"));
    if (event.type === "system" && event.subtype === "permission_denied")
      return this.fail(new Error("Claude Code permission denied; execution requires approval"));
    if (event.type === "system" && event.subtype === "init") {
      if (!identifier(event.session_id) || (this.sessionId && this.sessionId !== event.session_id))
        return this.fail(new Error("Claude Code returned an invalid session identifier"));
      this.sessionId = event.session_id;
      return;
    }
    if (event.type !== "result") return;
    if (this.result) return this.fail(new Error("Claude Code returned duplicate result protocol data"));
    if (event.subtype !== "success" || event.is_error === true) {
      const subtype = typeof event.subtype === "string" && /^error_[a-z_]+$/.test(event.subtype)
        ? ` (${event.subtype})` : "";
      return this.fail(new Error(`Claude Code execution failed${subtype}`));
    }
    if (event.is_error !== false || typeof event.result !== "string" || !event.result.trim())
      return this.fail(new Error("Claude Code returned invalid result protocol data"));
    if (event.terminal_reason !== undefined && event.terminal_reason !== "completed") {
      const reason = typeof event.terminal_reason === "string" && /^[a-z_]+$/.test(event.terminal_reason)
        ? event.terminal_reason : "unknown";
      return this.fail(new Error(`Claude Code execution incomplete (${reason})`));
    }
    if (event.stop_reason === "refusal" || event.stop_reason === "max_tokens" || event.stop_reason === "tool_deferred")
      return this.fail(new Error("Claude Code execution did not complete the requested work"));
    if (!Array.isArray(event.permission_denials))
      return this.fail(new Error("Claude Code returned invalid permission protocol data"));
    if (event.permission_denials.length)
      return this.fail(new Error("Claude Code permission denied; execution requires approval"));
    if (!identifier(event.session_id) || !identifier(event.uuid))
      return this.fail(new Error("Claude Code did not return native result identifiers"));
    if (this.sessionId && this.sessionId !== event.session_id)
      return this.fail(new Error("Claude Code result session does not match the started session"));
    this.sessionId = event.session_id;
    this.result = {
      summary: event.result,
      // Runner collects actual workspace changes after teardown. The CLI report
      // alone is neither a portable artifact nor evidence of passing checks.
      artifacts: [], checksPassed: false,
      nativeSession: { threadId: event.session_id, turnId: event.uuid },
    };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    let stopError = false;
    const kill = (signal: NodeJS.Signals) => {
      if (!this.child.pid) return;
      try { process.kill(-this.child.pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") stopError = true; }
    };
    if (!this.closed) kill("SIGTERM");
    const escalation = setTimeout(() => kill("SIGKILL"), 300);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.closePromise,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new ExecutorStopUnconfirmed()), 2000);
        }),
      ]);
    } finally {
      clearTimeout(escalation);
      clearTimeout(deadline);
      kill("SIGKILL"); // A parent exit does not prove that its children stopped.
    }
    if (stopError) throw new ExecutorStopUnconfirmed();
    if (!this.child.pid) return;
    const until = Date.now() + 2000;
    while (true) {
      try { process.kill(-this.child.pid, 0); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ESRCH") return;
        if (code !== "EPERM") throw new ExecutorStopUnconfirmed();
      }
      if (Date.now() >= until) throw new ExecutorStopUnconfirmed();
      await delay(10);
    }
  }
}

/** Experimental local preview: file tools only, no production credential wiring. */
export class ClaudeCodeExecutor implements Executor {
  constructor(private options: Options = {}) {}

  async run(input: ExecutionInput, signal: AbortSignal): Promise<ExecutionResult> {
    const assessment = input.purpose === "assess" || input.purpose === "decompose";
    if (assessment && input.code) throw new Error("Assessment cannot contain code input");
    if (!isAbsolute(input.cwd)) throw new Error("Claude Code workspace must be an absolute directory");
    if (signal.aborted) throw new Error("Claude Code execution cancelled");
    if (process.platform === "win32") throw new Error("Claude Code preview requires POSIX process groups");
    if (this.options.permissionMode === "bypassPermissions")
      throw new Error("Claude Code restricted preview does not permit bypassPermissions");
    const timeoutMs = this.options.timeoutMs ?? 15 * 60_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
      throw new Error("Claude Code timeout must be positive and within the timer range");
    const prompt = `Task: ${input.title}\n\n${input.description}\n\nAcceptance criteria:\n${input.acceptance}\n\nPrior review feedback:\n${input.feedback.join("\n") || "None"}\n\n${assessment ? "Return only the requested structured assessment." : "Provide a concise final report of changes and actual validation performed. Shell execution is unavailable; clearly identify checks you could not run."}`;
    const peer = new ClaudeProcess(this.options, input, prompt, assessment);
    const onAbort = () => peer.fail(new Error("Claude Code execution cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    const timer = setTimeout(() => peer.fail(new Error("Claude Code execution timed out")), timeoutMs);
    try { return await peer.completion; }
    finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      await peer.stop();
    }
  }
}

function metadataCommand(options: Options, args: string[]): Promise<string | null> {
  return new Promise(resolve => {
    execFile(options.command ?? "claude", args, {
      env: harnessEnvironment(), timeout: 5000, killSignal: "SIGKILL", maxBuffer: 4096,
    }, (error, stdout) => resolve(error ? null : stdout));
  });
}

async function authStatus(options: Options): Promise<JsonObject | null> {
  const stdout = await metadataCommand(options, ["auth", "status"]);
  if (!stdout) return null;
  try {
    const status: unknown = JSON.parse(stdout);
    return isObject(status) && status.loggedIn === true &&
      ["claude.ai", "oauth_token", "api_key", "api_key_helper"].includes(String(status.authMethod)) ? status : null;
  } catch { return null; }
}

/** Read-only CLI metadata checks; never starts a model session or login flow. */
export async function probeClaudeCode(options: Options = {}): Promise<{
  available: boolean; version: string | null; authenticated: boolean;
}> {
  const stdout = await metadataCommand(options, ["--version"]);
  const version = stdout?.match(/\b([0-9]+\.[0-9]+\.[0-9]+(?:[-+][\w.-]+)?)\s+\(Claude Code\)/)?.[1] ?? null;
  if (!version) return { available: false, version: null, authenticated: false };
  return { available: true, version, authenticated: !!await authStatus(options) };
}

export async function readClaudeCodeAccount(options: Options = {}): Promise<ClaudeCodeAccount | null> {
  const status = await authStatus(options);
  if (!status) return null;
  if (status.authMethod === "api_key" || status.authMethod === "api_key_helper") return { type: "apiKey" };
  return typeof status.email === "string" && status.email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(status.email)
    ? { type: "anthropic", email: status.email } : null;
}
