import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { isAbsolute, resolve, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import {ExecutorTimeout} from '../domain/execution-errors.ts';
import type {
  ExecutionInput,
  ExecutionResult,
  Executor,
  ExecutionMessageHandler,
  ExecutionMessageOutcome,
} from "../domain/contracts.ts";

export type CodexAccount = { type: "chatgpt"; email: string } | { type: "apiKey" };
export type Options = {
  command?: string;
  args?: string[];
  timeoutMs?: number;
  codexHome?: string;
  expectedAccount?: CodexAccount;
};
type JsonObject = Record<string, any>;
type NativeResult = ExecutionResult & {
  nativeSession: { threadId: string; turnId: string };
};
const MAX_LINE = 8 * 1024 * 1024;
const MAX_OUTPUT = 32 * 1024 * 1024;
class CodexRpcRejected extends Error {}

// Credentials for workflow storage and service administration never enter the harness.
// HOME/CODEX_HOME permit the member's existing Codex login without reading its contents.
function harnessEnvironment(options: Options = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "CODEX_HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "SYSTEMROOT",
    "WINDIR",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (options.codexHome) {
    if (!isAbsolute(options.codexHome))
      throw new Error("Codex home must be absolute");
    env.CODEX_HOME = options.codexHome;
  }
  return env;
}

class RpcPeer {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<
    number,
    { resolve: (value: JsonObject) => void; reject: (error: Error) => void }
  >();
  private nextId = 1;
  private closed = false;
  private stopping = false;
  private failure: Error | undefined;
  private rejectFailure!: (error: Error) => void;
  private closePromise: Promise<void>;
  readonly failed: Promise<never>;
  onNotification: (method: string, params: JsonObject) => void = () => {};

  constructor(options: Options, cwd: string) {
    this.failed = new Promise((_, reject) => {
      this.rejectFailure = reject;
    });
    void this.failed.catch(() => {});
    this.child = spawn(
      options.command ?? "codex",
      options.args ?? [
        ...(options.codexHome
          ? ["-c", 'cli_auth_credentials_store="file"']
          : []),
        "app-server",
        "--listen",
        "stdio://",
      ],
      {
        cwd,
        env: harnessEnvironment(options),
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    this.closePromise = new Promise((resolveClose) =>
      this.child.once("close", () => {
        this.closed = true;
        if (!this.stopping)
          this.fail(new Error("Codex exited before native completion"));
        resolveClose();
      }),
    );
    this.child.once("error", () =>
      this.fail(new Error("Codex process could not start")),
    );
    this.child.stdin.on("error", () => {
      if (!this.stopping) this.fail(new Error("Codex input stream failed"));
    });
    this.child.stdout.on("error", () =>
      this.fail(new Error("Codex output stream failed")),
    );
    // Drain without retaining raw diagnostics, which may include tokens or private paths.
    this.child.stderr.resume();
    let buffer = "";
    let total = 0;
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      if (this.stopping || this.failure) return;
      total += Buffer.byteLength(chunk);
      buffer += chunk;
      if (total > MAX_OUTPUT || buffer.length > MAX_LINE)
        return this.fail(new Error("Codex output exceeded adapter limit"));
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        try {
          this.receive(JSON.parse(line));
        } catch {
          this.fail(new Error("Codex returned invalid JSON protocol data"));
          return;
        }
      }
    });
  }

  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.rejectFailure(error);
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private send(message: JsonObject): void {
    if (!this.closed && !this.child.stdin.destroyed)
      this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private receive(message: JsonObject): void {
    if (!message || typeof message !== "object")
      throw new Error("invalid message");
    if (typeof message.method === "string") {
      if (message.id !== undefined) {
        this.send({
          id: message.id,
          error: {
            code: -32601,
            message: "Runner does not support interactive server requests",
          },
        });
        const kind = /approval/i.test(message.method)
          ? "approval request"
          : /input|elicitation/i.test(message.method)
            ? "human input request"
            : "server control request";
        this.fail(new Error(`Codex unsupported ${kind}; execution stopped`));
      } else this.onNotification(message.method, message.params ?? {});
      return;
    }
    const request = this.pending.get(message.id);
    if (!request) return;
    this.pending.delete(message.id);
    if (message.error) request.reject(new CodexRpcRejected("Codex RPC request rejected"));
    else if (message.result && typeof message.result === "object")
      request.resolve(message.result);
    else request.reject(new Error("Codex RPC returned invalid result"));
  }

  request(method: string, params: JsonObject, timeoutMs?:number): Promise<JsonObject> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolveRequest, reject) => {
      const timer=timeoutMs?setTimeout(()=>{this.pending.delete(id);reject(new Error('Codex RPC receipt timed out'));},timeoutMs):undefined;
      this.pending.set(id, { resolve:value=>{clearTimeout(timer);resolveRequest(value);}, reject:error=>{clearTimeout(timer);reject(error);} });
      this.send({ id, method, params });
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "multiagent_scrum_runner",
        title: "MultiAgent Scrum Runner",
        version: "0.1.0",
      },
    });
    this.send({ method: "initialized", params: {} });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for(const pending of this.pending.values())pending.reject(new Error('Codex session closed before receipt'));
    this.pending.clear();
    const kill = (signal: NodeJS.Signals) => {
      if (!this.child.pid) return;
      try {
        if (process.platform !== "win32") process.kill(-this.child.pid, signal);
        else if (!this.closed) this.child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
          this.child.kill(signal);
      }
    };
    if (this.closed) {
      kill("SIGKILL");
      return;
    }
    kill("SIGTERM");
    const escalation = setTimeout(() => kill("SIGKILL"), 300);
    try {
      await this.closePromise;
    } finally {
      clearTimeout(escalation);
      kill("SIGKILL");
    }
  }
}

async function withPeer<T>(
  options: Options,
  cwd: string,
  signal: AbortSignal,
  operation: (peer: RpcPeer) => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw new Error("Codex execution cancelled");
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("Codex timeout must be positive");
  const peer = new RpcPeer(options, cwd);
  const onAbort = () => peer.fail(new Error("Codex execution cancelled"));
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => peer.fail(new ExecutorTimeout()),
    timeoutMs,
  );
  try {
    return await Promise.race([operation(peer), peer.failed]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    await peer.stop();
  }
}

export class CodexExecutor implements Executor {
  private options: Options;
  constructor(options: Options = {}) {
    this.options = options;
  }

  async run(input: ExecutionInput, signal: AbortSignal): Promise<NativeResult> {
    const assessment=input.purpose==='assess'||input.purpose==='decompose';
    if(assessment&&input.code)throw Error('Assessment cannot contain code input');
    if (!isAbsolute(input.cwd))
      throw new Error("Codex workspace must be an absolute directory");
    let acceptingMessages=false;
    const notifyMessageHandler=(handler:ExecutionMessageHandler|null)=>{if(!assessment){try{input.onMessageReady?.(handler);}catch{/* Optional channel cannot control execution. */}}};
    const closeMessages=()=>{acceptingMessages=false;notifyMessageHandler(null);};
    signal.addEventListener('abort',closeMessages,{once:true});
    const options={...this.options,timeoutMs:this.options.timeoutMs??(assessment?10*60_000:60*60_000)};
    try{return await withPeer(options, input.cwd, signal, async (peer) => {
      await peer.initialize();
      if (this.options.expectedAccount) {
        const actual = accountMetadata(
          await peer.request("account/read", { refreshToken: false }),
        );
        if (!actual || actual.type !== this.options.expectedAccount.type ||
          (actual.type === 'chatgpt' && this.options.expectedAccount.type === 'chatgpt' && actual.email !== this.options.expectedAccount.email))
          throw new Error(
            "Codex account changed or expired; reconnect before execution",
          );
      }
      const started = await peer.request("thread/start", {
        ...(input.model?{model:input.model}:{}),
        cwd: input.cwd,
        sandbox: assessment?"read-only":"workspace-write",
        approvalPolicy: "never",
        config: {
          "sandbox_workspace_write.network_access": false,
          "sandbox_workspace_write.writable_roots": [],
        },
      });
      if(input.model&&started.model!==input.model)throw Error('Selected Codex model was not honored; execution stopped');
      const threadId = started.thread?.id;
      if (typeof threadId !== "string" || !threadId)
        throw new Error("Codex did not return a native thread identifier");
      const sandbox = started.sandbox;
      const roots = sandbox?.writableRoots;
      const rootsSafe =
        Array.isArray(roots) &&
        roots.every((root: unknown) => {
          if (typeof root !== "string" || !isAbsolute(root)) return false;
          const rel = relative(resolve(input.cwd), resolve(root));
          return (
            rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
          );
        });
      if (
        started.approvalPolicy !== "never" ||
        sandbox?.type !== (assessment?"readOnly":"workspaceWrite") ||
        sandbox.networkAccess !== false ||
        (!assessment&&!rootsSafe) ||
        resolve(started.cwd ?? "") !== resolve(input.cwd)
      ) {
        throw new Error(
          "Codex sandbox or approval policy does not match the requested execution boundary",
        );
      }
      let turnId: string | undefined;
      let summary = "";
      let diff = "";
      const queued: Array<[string, JsonObject]> = [];
      let complete!: (value: NativeResult) => void;
      let failTurn!: (error: Error) => void;
      const completion = new Promise<NativeResult>((resolveResult, reject) => {
        complete = resolveResult;
        failTurn = reject;
      });
      void completion.catch(() => {});
      const toolLabels: Record<string, string> = {
        commandExecution: '执行命令', fileChange: '修改文件', mcpToolCall: '调用工具',
        dynamicToolCall: '调用工具', webSearch: '搜索资料', imageView: '查看图片',
        collabAgentToolCall: '协作任务',
      };
      const handle = (method: string, params: JsonObject) => {
        if (params.threadId !== threadId) return;
        if (
          !["item/started", "item/completed", "turn/diff/updated", "turn/completed"].includes(
            method,
          )
        )
          return;
        if (!turnId) {
          if (queued.length >= 512)
            return peer.fail(
              new Error("Codex pre-response event limit exceeded"),
            );
          queued.push([method, params]);
          return;
        }
        if (
          (method === "turn/completed" ? params.turn?.id : params.turnId) !==
          turnId
        )
          return;
        if (!assessment && input.onProgress && (method === 'item/started' || method === 'item/completed')) {
          const item = params.item;
          if (typeof item?.id === 'string' && item.id.length > 0 && item.id.length <= 200) {
            const id = 'codex:' + createHash('sha256').update(item.id).digest('hex').slice(0,32);
            // Native item payloads can contain commands, source and credentials.
            // Project only visible assistant messages and fixed tool categories.
            try {
              if (method === 'item/completed' && item.type === 'agentMessage' &&
                (item.phase == null || item.phase === 'commentary' || item.phase === 'final') && typeof item.text === 'string')
                input.onProgress({id,kind:'message',text:item.text,state:'completed'});
              else if (Object.hasOwn(toolLabels,item.type))
                input.onProgress({id,kind:'tool',text:toolLabels[item.type],state:method === 'item/started' ? 'running' :
                  item.status === 'failed' || item.status === 'declined' || item.success === false || item.error != null ||
                    (typeof item.exitCode === 'number' && item.exitCode !== 0) ? 'failed' : 'completed'});
            } catch { /* An optional progress observer never controls native execution. */ }
          }
        }
        if (
          method === "item/completed" &&
          params.item?.type === "agentMessage" &&
          typeof params.item.text === "string"
        )
          summary = params.item.text;
        if (method === "turn/diff/updated" && typeof params.diff === "string")
          diff = params.diff;
        if (method === "turn/completed") {
          closeMessages();
          if (params.turn.status !== "completed" || params.turn.error != null) {
            const status =
              params.turn.status === "interrupted" ? "interrupted" : "failed";
            failTurn(new Error(`Codex turn ${status}`));
          } else
            complete({
              summary,
              artifacts: !assessment&&diff ? [{ name: "changes.patch", content: diff }] : [],
              checksPassed: false,
              nativeSession: { threadId, turnId },
            });
        }
      };
      peer.onNotification = handle;
      const response = await peer.request("turn/start", {
        threadId,
        cwd: input.cwd,
        approvalPolicy: "never",
        sandboxPolicy: assessment?{type:'readOnly',networkAccess:false}:{
          type: "workspaceWrite",
          writableRoots: [input.cwd],
          networkAccess: false,
          excludeSlashTmp: true,
          excludeTmpdirEnvVar: true,
        },
        input: [
          {
            type: "text",
            text: `Task: ${input.title}\n\n${input.description}\n\nAcceptance criteria:\n${input.acceptance}\n\nPrior review feedback:\n${input.feedback.join("\n") || "None"}\n\n${assessment?'Return only the requested structured assessment.':'Provide a concise final report of changes and actual validation performed.'}`,
            text_elements: [],
          },
        ],
      });
      if (typeof response.turn?.id !== "string" || !response.turn.id)
        throw new Error("Codex did not return a native turn identifier");
      turnId = response.turn.id;
      acceptingMessages=!assessment&&!signal.aborted;
      for (const [method, params] of queued) handle(method, params);
      if(acceptingMessages&&input.onMessageReady){
        const expectedTurnId=turnId!;
        const messages=new Map<string,{text:string;receipt:Promise<ExecutionMessageOutcome>}>();
        const steer:ExecutionMessageHandler=message=>{
          if(typeof message.id!=='string'||!message.id||message.id.length>160||typeof message.text!=='string'||!message.text.trim()||message.text.length>2000)return Promise.resolve('rejected');
          const previous=messages.get(message.id);
          if(previous)return previous.text===message.text?previous.receipt:Promise.resolve('rejected');
          if(!acceptingMessages||signal.aborted||messages.size>=128)return Promise.resolve('rejected');
          const receipt=peer.request('turn/steer',{threadId,expectedTurnId,clientUserMessageId:message.id,input:[{type:'text',text:message.text,text_elements:[]}]},5000)
            .then((result):ExecutionMessageOutcome=>result.turnId===expectedTurnId?'delivered':'unknown',
              (error):ExecutionMessageOutcome=>error instanceof CodexRpcRejected?'rejected':'unknown');
          messages.set(message.id,{text:message.text,receipt});return receipt;
        };
        notifyMessageHandler(steer);
      }
      return completion;
    });}finally{closeMessages();signal.removeEventListener('abort',closeMessages);}
  }
}

/** Read-only local availability check. Never starts a thread, turn, or login flow. */
export async function probeCodex(options: Options = {}): Promise<{
  available: boolean;
  version: string | null;
  authenticated: boolean;
}> {
  const version = await new Promise<string | null>((resolveVersion) => {
    execFile(
      options.command ?? "codex",
      ["--version"],
      {
        env: harnessEnvironment(options),
        timeout: 5000,
        killSignal: "SIGKILL",
        maxBuffer: 4096,
      },
      (error, stdout) => {
        const match = stdout?.match(
          /codex-cli\s+([0-9]+\.[0-9]+\.[0-9]+(?:[-+][\w.-]+)?)/,
        );
        resolveVersion(!error && match ? match[1]! : null);
      },
    );
  });
  if (!version)
    return { available: false, version: null, authenticated: false };
  try {
    const authenticated = await withPeer(
      { ...options, timeoutMs: 8000 },
      process.cwd(),
      new AbortController().signal,
      async (peer) => {
        await peer.initialize();
        const result = await peer.request("account/read", {
          refreshToken: false,
        });
        return (
          !!result.account &&
          ["chatgpt", "apiKey", "amazonBedrock"].includes(result.account.type)
        );
      },
    );
    return { available: true, version, authenticated };
  } catch {
    return { available: false, version, authenticated: false };
  }
}

function accountMetadata(result: JsonObject): CodexAccount | null {
  const a = result.account;
  if (a?.type === 'apiKey') return { type: 'apiKey' };
  return a?.type === "chatgpt" &&
    typeof a.email === "string" &&
    a.email.length <= 254 &&
    /^[^\s@]+@[^\s@]+$/.test(a.email)
    ? { type: "chatgpt", email: a.email }
    : null;
}

/** Authenticates only an isolated Runner profile; the key is sent through the
 * local app-server pipe and never put in environment variables or arguments. */
export async function loginCodexApiKey(options: Options, apiKey: string): Promise<CodexAccount> {
  if (!options.codexHome) throw new Error('Refusing to overwrite shared local Codex credentials');
  if (!/^[\x21-\x7e]{1,1024}$/.test(apiKey)) throw new Error('Invalid Codex API key');
  return withPeer({timeoutMs: 15000, ...options}, process.cwd(), new AbortController().signal, async peer => {
    await peer.initialize();
    const response = await peer.request('account/login/start', {type:'apiKey',apiKey});
    if (response.type !== 'apiKey') throw new Error('Codex API key login did not complete');
    const account = accountMetadata(await peer.request('account/read',{refreshToken:false}));
    if (account?.type !== 'apiKey') throw new Error('Codex API key account was not confirmed');
    return account;
  });
}

export async function readCodexAccount(
  options: Options = {},
): Promise<CodexAccount | null> {
  return withPeer(
    { timeoutMs: 8000, ...options },
    process.cwd(),
    new AbortController().signal,
    async (peer) => {
      await peer.initialize();
      return accountMetadata(
        await peer.request("account/read", { refreshToken: false }),
      );
    },
  );
}

/** Read only local app-server metadata. No rollout contents or credentials leave
 * the Runner; callers must further bound what they expose to the browser. */
export async function listCodexLocalThreads(options: Options = {}): Promise<{
  account: CodexAccount | null;
  threads: {id:string;cwd:string;name:string|null;preview:string;createdAt:number;updatedAt:number;status:unknown}[];
}> {
  return withPeer({timeoutMs:10_000,...options},process.cwd(),new AbortController().signal,async peer=>{
    await peer.initialize();
    const account=accountMetadata(await peer.request('account/read',{refreshToken:false}));
    const response=await peer.request('thread/list',{limit:50,sortKey:'updated_at',sortDirection:'desc',sourceKinds:[]});
    if(!Array.isArray(response.data))throw Error('Codex thread list is invalid');
    return {account,threads:response.data.flatMap((item:unknown)=>{
      if(!item||typeof item!=='object')return [];
      const row=item as Record<string,unknown>;
      if(typeof row.id!=='string'||typeof row.cwd!=='string'||typeof row.createdAt!=='number'||typeof row.updatedAt!=='number')return [];
      return [{id:row.id,cwd:row.cwd,name:typeof row.name==='string'?row.name:null,preview:typeof row.preview==='string'?row.preview:'',createdAt:row.createdAt,updatedAt:row.updatedAt,status:row.status}];
    })};
  });
}

export async function logoutCodex(options: Options): Promise<void> {
  // A shared local login must NEVER be logged out by this product.
  if (!options.codexHome)
    throw new Error("Refusing to log out shared local Codex credentials");
  await withPeer(
    { timeoutMs: 8000, ...options },
    process.cwd(),
    new AbortController().signal,
    async (peer) => {
      await peer.initialize();
      await peer.request("account/logout", {});
    },
  );
}

export async function loginCodex(
  options: Options,
  signal: AbortSignal,
  onUrl: (url: string) => void,
): Promise<CodexAccount> {
  if (!options.codexHome)
    throw new Error("Refusing to log in over shared local Codex credentials");
  return withPeer(
    { timeoutMs: 300000, ...options },
    process.cwd(),
    signal,
    async (peer) => {
      await peer.initialize();
      let loginId: string | undefined;
      const early: JsonObject[] = [];
      let complete!: () => void, failed!: (error: Error) => void;
      const done = new Promise<void>((resolveDone, reject) => {
        complete = resolveDone;
        failed = reject;
      });
      // The RPC lifetime race owns failure; also observe early rejection immediately.
      void done.catch(() => {});
      const handle = (params: JsonObject) => {
        if (params.loginId !== loginId) return;
        if (params.success === true) complete();
        else failed(new Error("Codex login failed; try again"));
      };
      peer.onNotification = (method, params) => {
        if (method !== "account/login/completed") return;
        if (!loginId) {
          if (early.length >= 16)
            throw new Error("Too many login notifications");
          early.push(params);
        } else handle(params);
      };
      const response = await peer.request("account/login/start", {
        type: "chatgpt",
      });
      if (typeof response.loginId !== "string" || !response.loginId)
        throw new Error("Missing login identifier");
      loginId = response.loginId;
      const url = new URL(response.authUrl);
      if (
        url.protocol !== "https:" ||
        !["auth.openai.com", "chatgpt.com"].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.port
      )
        throw new Error("Untrusted Codex login URL");
      const cancel = () => {
        void peer.request("account/login/cancel", { loginId }).catch(() => {});
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        onUrl(url.href);
        for (const params of early) handle(params);
        await done;
        signal.throwIfAborted();
        const account = accountMetadata(
          await peer.request("account/read", { refreshToken: false }),
        );
        if (account?.type !== 'chatgpt')
          throw new Error("Codex login did not provide a supported account");
        return account;
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
  );
}
