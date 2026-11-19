import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type WireObject = Record<string, unknown>;
export const isObject = (value: unknown): value is WireObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// This transport owns a POSIX process group, not an OS sandbox. A trusted
// launcher must enforce filesystem/network policy and prevent detached escapes.
export class DshProcess {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve: (value: WireObject) => void; reject: (error: Error) => void }
  >();
  private error?: Error;
  private closed = false;
  private stopping = false;
  private exited: Promise<void>;
  private rejectFailure!: (error: Error) => void;
  readonly failed: Promise<never>;
  onNotification: (method: string, params: WireObject) => void = () => {};

  constructor(command: string, args: string[], cwd: string) {
    const env: NodeJS.ProcessEnv = {};
    // No ambient model credentials, runtime home, NODE_OPTIONS or DB secrets.
    // This alone does not stop a runtime from reading files in the real home.
    for (const key of ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"])
      if (process.env[key] !== undefined) env[key] = process.env[key];
    this.failed = new Promise((_, reject) => {
      this.rejectFailure = reject;
    });
    void this.failed.catch(() => {});
    this.child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise((resolve) =>
      this.child.once("close", () => {
        this.closed = true;
        if (!this.stopping)
          this.fail(new Error("DSH exited before completion"));
        resolve();
      }),
    );
    this.child.once("error", () =>
      this.fail(new Error("DSH process could not start")),
    );
    this.child.stdin.on("error", () => {
      if (!this.stopping) this.fail(new Error("DSH input stream failed"));
    });
    this.child.stdout.on("error", () =>
      this.fail(new Error("DSH output stream failed")),
    );
    this.child.stderr.on("error", () =>
      this.fail(new Error("DSH diagnostic stream failed")),
    );
    this.child.stderr.resume(); // Never retain raw errors, private paths or credentials.
    let buffer = "";
    let bytes = 0;
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      if (this.stopping || this.error) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 8 * 1024 * 1024)
        return this.fail(new Error("DSH output limit exceeded"));
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > 1024 * 1024)
          return this.fail(new Error("DSH frame limit exceeded"));
        if (!line.trim()) continue;
        try {
          this.receive(JSON.parse(line));
        } catch {
          return this.fail(new Error("DSH invalid protocol data"));
        }
        if (this.error) return;
      }
      if (Buffer.byteLength(buffer) > 1024 * 1024)
        this.fail(new Error("DSH frame limit exceeded"));
    });
  }

  fail(error: Error): void {
    if (this.error) return;
    this.error = error;
    this.rejectFailure(error);
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private send(message: WireObject): void {
    if (this.closed || this.child.stdin.destroyed) return;
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n",
    );
  }

  private receive(value: unknown): void {
    if (!isObject(value) || value.jsonrpc !== "2.0")
      return this.fail(new Error("DSH invalid protocol envelope"));
    if (typeof value.method === "string") {
      if (value.id !== undefined) {
        this.send({
          id: value.id,
          error: {
            code: -32601,
            message: "Interactive requests are unsupported",
          },
        });
        return this.fail(
          new Error("DSH interactive request requires unsupported human input"),
        );
      }
      if (!isObject(value.params))
        return this.fail(new Error("DSH invalid notification protocol"));
      this.onNotification(value.method, value.params);
      return;
    }
    if (typeof value.id !== "number")
      return this.fail(new Error("DSH invalid response protocol"));
    const request = this.pending.get(value.id);
    if (!request)
      return this.fail(new Error("DSH unexpected response protocol"));
    this.pending.delete(value.id);
    if (value.error !== undefined)
      request.reject(new Error("DSH RPC request failed"));
    else if (!isObject(value.result))
      request.reject(new Error("DSH invalid RPC result"));
    else request.resolve(value.result);
  }

  request(method: string, params: WireObject): Promise<WireObject> {
    if (this.error) return Promise.reject(this.error);
    if (Buffer.byteLength(JSON.stringify(params)) > 1024 * 1024)
      return Promise.reject(new Error("DSH request limit exceeded"));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const killGroup = (signal: NodeJS.Signals) => {
      if (!this.child.pid) return;
      try {
        process.kill(-this.child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
          throw new Error("DSH process group stop could not be confirmed");
      }
    };
    // Shutdown is best effort; no pending RPC is allowed to hold cleanup open.
    this.send({ id: ++this.sequence, method: "shutdown" });
    let stopError: Error | undefined;
    const signal = (value: NodeJS.Signals) => {
      try {
        killGroup(value);
      } catch (error) {
        stopError = error as Error;
      }
    };
    const term = setTimeout(() => signal("SIGTERM"), 100);
    const kill = setTimeout(() => signal("SIGKILL"), 300);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.exited,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error("DSH process exit was not confirmed")),
            2000,
          );
        }),
      ]);
    } finally {
      clearTimeout(term);
      clearTimeout(kill);
      clearTimeout(deadline);
      signal("SIGKILL"); // Also terminate same-group children if the parent exited first.
      this.fail(new Error("DSH transport closed"));
    }
    if (stopError) throw stopError;
    // Sending SIGKILL is not proof of exit. Refuse to release a successful
    // result until the owned group disappears (including a surviving child).
    if (this.child.pid) {
      const deadlineAt = Date.now() + 2000;
      while (true) {
        try {
          process.kill(-this.child.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
          // macOS can briefly report EPERM while a killed orphan is being
          // reaped. It is NOT exit evidence: keep polling until ESRCH or fail.
          if ((error as NodeJS.ErrnoException).code !== "EPERM")
            throw new Error("DSH process group exit could not be confirmed");
        }
        if (Date.now() >= deadlineAt)
          throw new Error("DSH process group exit was not confirmed");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }
}
