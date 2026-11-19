import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type {
  ExecutionInput,
  ExecutionResult,
  Executor,
} from "../domain/contracts.ts";
import { DshProcess, isObject, type WireObject } from "./dsh-process.ts";
import { DshTurnError } from './dsh-errors.ts';
import { ExecutorStopUnconfirmed } from '../domain/execution-errors.ts';
import type {ConversationEntry} from '../domain/task-conversation.ts';

export type DshOptions = {
  /** Explicit trusted launcher; no default profile, runtime discovery or installation. */
  command: string;
  args: string[];
  provider: string;
  model: string;
  maxTokens: number;
  timeoutMs?: number;
  /** Revalidate local consent after native services load, before any prompt. */
  beforePrompt?: () => Promise<void>;
};

/** SDK protocol adapter. Product scheduling uses only DshConnection and the
 * controlled DshTextExecutor profile, never arbitrary DshOptions from HTTP.
 * It consumes the DSH SDK wire protocol; it neither bundles DSH nor recreates its loop.
 */
export class DshExecutor implements Executor {
  private options: DshOptions;
  constructor(options: DshOptions) {
    const nonempty = (value: unknown): value is string =>
      typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= 256 &&
      !/[\r\n\0]/.test(value);
    if (
      !isAbsolute(options.command) ||
      !Array.isArray(options.args) ||
      !options.args.every(
        (arg) => typeof arg === "string" && !arg.includes("\0"),
      ) ||
      !nonempty(options.provider) ||
      !nonempty(options.model) ||
      !Number.isSafeInteger(options.maxTokens) ||
      options.maxTokens <= 0 ||
      !Number.isSafeInteger(options.timeoutMs ?? 600_000) ||
      (options.timeoutMs ?? 600_000) <= 0 ||
      (options.timeoutMs ?? 600_000) > 2_147_483_647
    )
      throw new Error("DSH launch configuration is invalid");
    this.options = { ...options, args: [...options.args] };
  }

  async run(
    input: ExecutionInput,
    signal: AbortSignal,
    // Host-owned scratch cleanup needs stop evidence independently of success.
    // This is only the existing POSIX process-group guarantee, not proof of
    // cancellation of arbitrary external effects or deliberately detached work.
    onStopped?: () => void,
  ): Promise<ExecutionResult> {
    if (signal.aborted) throw new Error("DSH execution cancelled");
    if (!isAbsolute(input.cwd))
      throw new Error("DSH workspace must be absolute");
    if (process.platform === "win32")
      throw new Error("DSH process containment is not supported on Windows");
    const peer = new DshProcess(
      this.options.command,
      this.options.args,
      resolve(input.cwd),
    );
    const abort = () => peer.fail(new Error("DSH execution cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(
      () => peer.fail(new Error("DSH execution timed out")),
      this.options.timeoutMs ?? 600_000,
    );
    let result: ExecutionResult;
    try {
      result = await Promise.race([this.execute(peer, input), peer.failed]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      try { await peer.stop(); } catch { throw new ExecutorStopUnconfirmed(); }
      onStopped?.();
    }
    if (signal.aborted) throw new Error("DSH execution cancelled");
    return result;
  }

  private async execute(
    peer: DshProcess,
    input: ExecutionInput,
  ): Promise<ExecutionResult> {
    const initialized = await peer.request("initialize", {
      cwd: resolve(input.cwd),
      provider: this.options.provider,
      model: this.options.model,
      maxTokens: this.options.maxTokens,
    });
    if (
      !isObject(initialized.serverInfo) ||
      initialized.serverInfo.name !== "deepseek-harness-sdk-runtime" ||
      typeof initialized.serverInfo.version !== "string" ||
      !initialized.serverInfo.version
    )
      throw new Error("DSH server identity is not supported");

    await this.options.beforePrompt?.();

    const sessionId = `mas-${randomUUID()}`;
    let messageId: string | undefined;
    let received = false;
    let openTurn: number | undefined;
    let lastTurn = 0;
    let completed = false;
    let summary = "";
    let lastSeq = -1;
    let done = false;
    const tools = new Map<string,string>();
    const publish = (entry:Omit<ConversationEntry,'at'>) => {
      if(input.purpose !== undefined) return;
      try { input.onProgress?.(entry); } catch { /* Progress cannot interrupt execution. */ }
    };
    const queued: Array<[string, WireObject]> = [];
    let queuedBytes = 0;
    let finish!: (result: ExecutionResult) => void;
    const completion = new Promise<ExecutionResult>((resolveResult) => {
      finish = resolveResult;
    });
    const fail = (message: string) => {
      done = true;
      peer.fail(new Error(message));
    };
    const handle = (method: string, params: WireObject) => {
      if (
        done ||
        params.sessionId !== sessionId ||
        !["session.event", "session.status"].includes(method)
      )
        return;
      if (!messageId) {
        queuedBytes += Buffer.byteLength(JSON.stringify(params));
        if (queued.length >= 512 || queuedBytes > 1024 * 1024)
          return fail("DSH pre-response event limit exceeded");
        queued.push([method, params]);
        return;
      }
      if (method === "session.status") {
        if (!received) return;
        if (params.status === "running") return;
        if (params.status !== "idle")
          return fail("DSH invalid status protocol");
        if (!completed || openTurn !== undefined)
          return fail("DSH became idle without a completed turn");
        if (!summary.trim())
          return fail("DSH completed without a final report");
        done = true;
        finish({
          summary,
          artifacts: [],
          checksPassed: false,
          nativeSession: { threadId: sessionId, turnId: String(lastTurn) },
        });
        return;
      }
      const event = params.event;
      if (
        !isObject(event) ||
        typeof event.type !== "string" ||
        !isObject(event.data)
      )
        return fail("DSH invalid event protocol");
      const data = event.data;
      // Another message may already be pending before our enqueue receipt.
      // Check the entire buffered root history, not only the post-receipt tail.
      // Pure deletions are normal claims; any later insertion is new input,
      // even if it reuses the already claimed message identity.
      if (event.type === "agent/inbox/spliced") {
        if (
          !Array.isArray(data.inserted) ||
          data.inserted.length > 1 ||
          (received && data.inserted.length > 0) ||
          data.inserted.some((item) => !isObject(item) || item.id !== messageId)
        )
          return fail("DSH unrelated or repeated input entered the owned activity");
        if (data.outcome === "canceled") return fail("DSH input was cancelled");
      }
      if (!received) {
        if (
          event.type !== "agent/inbox/spliced" ||
          !Array.isArray(data.inserted) ||
          !data.inserted.some((item) => isObject(item) && item.id === messageId)
        )
          return;
        received = true;
      }
      if (!Number.isSafeInteger(event.seq) || (event.seq as number) <= lastSeq)
        return fail("DSH invalid event sequence");
      lastSeq = event.seq as number;
      if (event.type === "agent/inbox/spliced") return;
      if (event.type === "turn/start") {
        if (
          openTurn !== undefined ||
          !Number.isSafeInteger(data.turn) ||
          (data.turn as number) <= lastTurn
        )
          return fail("DSH invalid turn start");
        openTurn = data.turn as number;
        lastTurn = openTurn;
        completed = false;
        summary = "";
        tools.clear();
      } else if (event.type === "assistant/message") {
        if (openTurn === undefined || data.turn !== openTurn)
          return fail("DSH assistant message belongs to an unexpected turn");
        if (
          data.interrupted !== undefined ||
          !isObject(data.message) ||
          !Array.isArray(data.message.content)
        )
          return fail("DSH incomplete assistant message");
        const texts: string[] = [];
        for (const block of data.message.content) {
          if (!isObject(block) || typeof block.type !== "string")
            return fail("DSH malformed assistant message");
          if (block.type === "text") {
            if (typeof block.text !== "string")
              return fail("DSH malformed assistant message text");
            texts.push(block.text);
          }
        }
        summary = texts.join("");
        if(summary.trim()) publish({id:`dsh-message-${event.seq}`,kind:'message',text:summary,state:'completed'});
      } else if (event.type === 'tool/call') {
        if(openTurn === undefined || data.turn !== openTurn || typeof data.callId !== 'string' || !data.callId || data.callId.length > 256 || tools.has(data.callId)) return;
        // ponytail: retain at most 128 pending tool pairs; raise only if a native
        // profile needs more simultaneous calls. Raw tool data never leaves here.
        if(tools.size >= 128) return;
        const id=`dsh-tool-${event.seq}`;
        tools.set(data.callId,id);
        publish({id,kind:'tool',text:'执行工具',state:'running'});
      } else if (event.type === 'tool/result') {
        if(openTurn === undefined || data.turn !== openTurn || !isObject(data.message) || typeof data.message.callId !== 'string') return;
        const id=tools.get(data.message.callId);
        if(!id || (data.message.isError !== undefined && typeof data.message.isError !== 'boolean')) return;
        tools.delete(data.message.callId);
        publish({id,kind:'tool',text:'执行工具',state:data.message.isError || data.error !== undefined ? 'failed':'completed'});
      } else if (event.type === "turn/end") {
        if (
          openTurn === undefined ||
          data.turn !== openTurn ||
          !isObject(data.reason)
        )
          return fail("DSH turn did not complete successfully");
        if (data.reason.kind !== 'completed') {
          done = true;
          peer.fail(new DshTurnError(data.reason.kind === 'error' && isObject(data.reason.error) ? data.reason.error.code : undefined));
          return;
        }
        openTurn = undefined;
        completed = true;
      }
    };
    peer.onNotification = handle;
    const receipt = await peer.request("session/prompt", {
      sessionId,
      contentBlocks: [
        {
          type: "text",
          text: `Task: ${input.title}\n\n${input.description}\n\nAcceptance criteria:\n${input.acceptance}\n\nPrior review feedback:\n${input.feedback.join("\n") || "None"}\n\nProvide a concise final report of changes and actual validation performed.`,
        },
      ],
    });
    if (
      typeof receipt.messageId !== "string" ||
      !receipt.messageId.trim() ||
      receipt.messageId.length > 256
    )
      throw new Error("DSH invalid prompt receipt");
    messageId = receipt.messageId;
    for (const [method, params] of queued) handle(method, params);
    queued.length = 0;
    return completion;
  }
}
