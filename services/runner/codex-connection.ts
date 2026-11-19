import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rename,
  lstat,
  open,
  unlink,
} from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CodexExecutor,
  readCodexAccount,
  loginCodex,
  loginCodexApiKey,
  logoutCodex,
  type Options,
  type CodexAccount,
} from "../../packages/executors/codex.ts";
import type {
  Executor,
  ExecutionInput,
} from "../../packages/domain/contracts.ts";
import { DomainError } from "../../packages/domain/workflow.ts";

export type ConnectionView = {
  status: "disconnected" | "connecting" | "connected" | "draining" | "error";
  source: "local" | "private" | null;
  localDetected: boolean | null;
  accountLabel: string | null;
  authUrl?: string;
  message?: string;
};
type Auth = {
  read: typeof readCodexAccount;
  login: typeof loginCodex;
  loginApiKey: typeof loginCodexApiKey;
  logout: typeof logoutCodex;
};
const accountSchema = z.discriminatedUnion('type', [
  z.object({type:z.literal('chatgpt'),email:z.string().email().max(254)}).strict(),
  z.object({type:z.literal('apiKey')}).strict(),
]);
const recordSchema = z
  .object({
    source: z.enum(["local", "private"]),
    owner: z.string(),
    home: z.string().optional(),
    draining: z.boolean(),
    account: accountSchema,
  })
  .strict()
  .refine(record=>record.source!=='local'||record.account.type==='chatgpt');
type Record = z.infer<typeof recordSchema>;

async function privateDirectory(root: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const st = await lstat(root);
  if (!st.isDirectory() || st.isSymbolicLink() || st.mode & 0o077)
    throw new Error("Account directory must be private (0700)");
}
async function readPrivateJson(file: string): Promise<unknown> {
  let st;
  try {
    st = await lstat(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  if (!st.isFile() || st.isSymbolicLink() || st.mode & 0o077 || st.size > 4096)
    throw new Error("Unsafe connection metadata");
  return JSON.parse(await readFile(file, "utf8"));
}
async function writePrivateJson(file: string, value: unknown) {
  const tmp = file + "." + randomUUID();
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await rename(tmp, file);
}

/** Fail closed after an unclean crash. Never steal an old process's lock automatically. */
export async function acquireAccountLock(root: string) {
  await privateDirectory(root);
  const file = join(root, "runtime.lock");
  let handle;
  try {
    handle = await open(file, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "Codex account directory already occupied; verify the previous process stopped before recovering runtime.lock",
      );
    throw e;
  }
  await handle.writeFile(
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
  const owned = await handle.stat();
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      const current = await lstat(file);
      if (current.ino === owned.ino && current.dev === owned.dev)
        await unlink(file);
    } finally {
      await handle.close();
    }
  };
}

/** Device-local consent; never serialize this object into the shared workspace. */
export class CodexConnection implements Executor {
  private record: Record | null = null;
  private status: ConnectionView["status"] = "disconnected";
  private localDetected: boolean | null = null;
  private authUrl?: string;
  private message?: string;
  private login?: { controller: AbortController; promise: Promise<void> };
  private operation?: Promise<void>;
  private closing = false;
  private filename: string;
  private pendingHome: string | null = null;
  constructor(
    readonly root: string,
    readonly owner: string,
    private options: Options = {},
    private auth: Auth = {
      read: readCodexAccount,
      login: loginCodex,
      loginApiKey: loginCodexApiKey,
      logout: logoutCodex,
    },
  ) {
    this.root = resolve(root);
    this.filename = join(this.root, "connection.json");
  }
  async initialize() {
    await privateDirectory(this.root);
    const value = await readPrivateJson(this.filename);
    if (value !== null) {
      const saved = recordSchema.parse(value);
      if (
        saved.owner !== this.owner ||
        (saved.source === "local" && saved.home)
      )
        throw new Error("Connection owner mismatch");
      if (saved.source === "private") {
        await this.validateProfile(saved.home);
      }
      this.record = saved;
      // A interrupted drain must not silently reconnect after restart.
      this.status = saved.draining ? "draining" : "connected";
    }
    this.pendingHome = z
      .string()
      .nullable()
      .parse(await readPrivateJson(join(this.root, "pending-profile.json")));
    if (this.pendingHome) {
      await this.validateProfile(this.pendingHome);
      if (this.record?.home === this.pendingHome) {
        await writePrivateJson(join(this.root, "pending-profile.json"), null);
        this.pendingHome = null;
      } else {
        this.status = "error";
        this.message = "上次登录未正常结束，请退出连接清理后重新登录";
      }
    }
  }
  private async validateProfile(home?: string) {
    if (
      !home ||
      dirname(home) !== this.root ||
      !home.startsWith(join(this.root, "profile-"))
    )
      throw new Error("Invalid private profile");
    const profile = await lstat(home);
    if (
      !profile.isDirectory() ||
      profile.isSymbolicLink() ||
      profile.mode & 0o077
    )
      throw new Error("Unsafe private profile");
  }
  private async clearPending() {
    if (!this.pendingHome) return;
    await this.auth.logout({ ...this.options, codexHome: this.pendingHome });
    await writePrivateJson(join(this.root, "pending-profile.json"), null);
    this.pendingHome = null;
  }
  view(): ConnectionView {
    const email = this.record?.account.type === 'chatgpt' ? this.record.account.email : undefined;
    return {
      status: this.status,
      source: this.record?.source ?? (this.login ? "private" : null),
      localDetected: this.localDetected,
      accountLabel: this.record?.account.type === 'apiKey' ? 'API Key' : email ? email[0] + "***@" + email.split("@")[1] : null,
      ...(this.authUrl ? { authUrl: this.authUrl } : {}),
      ...(this.message ? { message: this.message } : {}),
    };
  }
  available(owner: string) {
    return (
      owner === this.owner &&
      !!this.record &&
      ["connected", "draining"].includes(this.status)
    );
  }
  accepting(owner: string) {
    return (
      this.available(owner) && this.status === "connected" && !this.closing
    );
  }
  private idle() {
    if (this.closing || this.status !== "disconnected" || this.operation)
      throw new DomainError("account_connected", "请先退出当前账号连接", 409);
  }
  private async save(record: Record | null) {
    await writePrivateJson(this.filename, record);
  }
  private runtimeOptions(record: Record): Options {
    return {
      ...this.options,
      ...(record.source === "private" ? { codexHome: record.home } : {}),
      expectedAccount: record.account,
    };
  }
  async detect() {
    this.idle();
    this.localDetected = !!(await this.auth.read(this.options));
    return this.view();
  }
  async connectLocal() {
    this.idle();
    this.status = "connecting";
    this.message = undefined;
    const work = (async () => {
      const account = await this.auth.read(this.options);
      if (!account || account.type !== 'chatgpt')
        throw new DomainError(
          "login_required",
          "未检测到有效 ChatGPT 登录，请登录账号",
          409,
        );
      const record: Record = {
        source: "local",
        owner: this.owner,
        account,
        draining: false,
      };
      await this.save(record);
      this.record = record;
      this.status = "connected";
    })();
    this.operation = work;
    try {
      await work;
    } catch (e) {
      this.status = "disconnected";
      throw e;
    } finally {
      this.operation = undefined;
    }
    return this.view();
  }
  async beginLogin() {
    this.idle();
    this.status = "connecting";
    this.message = undefined;
    const controller = new AbortController();
    let ready!: () => void;
    const urlReady = new Promise<void>((r) => {
      ready = r;
    });
    const promise = (async () => {
      const home = await mkdtemp(join(this.root, "profile-"));
      this.pendingHome = home;
      await writePrivateJson(join(this.root, "pending-profile.json"), home);
      controller.signal.throwIfAborted();
      const account = await this.auth.login(
        { ...this.options, codexHome: home },
        controller.signal,
        (url) => {
          if (!controller.signal.aborted) this.authUrl = url;
          ready();
        },
      );
      controller.signal.throwIfAborted();
      const record: Record = {
        source: "private",
        owner: this.owner,
        home,
        account,
        draining: false,
      };
      await this.save(record);
      // Disconnect waits this promise, including persistence, before clearing consent.
      this.record = record;
      await writePrivateJson(join(this.root, "pending-profile.json"), null);
      this.pendingHome = null;
      if (!controller.signal.aborted) this.status = "connected";
    })()
      .catch(async () => {
        try {
          await this.clearPending();
          if (this.record) {
            await this.save(null);
            this.record = null;
          }
          if (!controller.signal.aborted) {
            this.status = "disconnected";
            this.message = "登录未完成，请重新登录";
          }
        } catch {
          this.status = "error";
          this.message = "登录清理尚未完成，请退出连接后重试";
        }
      })
      .finally(() => {
        this.authUrl = undefined;
        ready();
      });
    this.login = { controller, promise };
    await urlReady;
    return this.view();
  }
  async connectApiKey(apiKey:string) {
    this.idle();
    this.status='connecting';
    this.message=undefined;
    const work=(async()=>{
      const home=await mkdtemp(join(this.root,'profile-'));
      this.pendingHome=home;
      await writePrivateJson(join(this.root,'pending-profile.json'),home);
      const account=await this.auth.loginApiKey({...this.options,codexHome:home},apiKey);
      if(account.type!=='apiKey')throw new Error('Codex API key account was not confirmed');
      const record:Record={source:'private',owner:this.owner,home,account,draining:false};
      await this.save(record);
      this.record=record;
      await writePrivateJson(join(this.root,'pending-profile.json'),null);
      this.pendingHome=null;
      this.status='connected';
    })();
    this.operation=work;
    try{await work;}
    catch(error){
      try{await this.clearPending();}catch{this.status='error';this.message='登录清理尚未完成，请退出连接后重试';throw error;}
      this.status='disconnected';
      throw error;
    }finally{this.operation=undefined;}
    return this.view();
  }
  async disconnect(drain: () => Promise<void>) {
    if (this.operation)
      throw new DomainError("account_busy", "账号操作处理中，请稍后重试", 409);
    if (this.status === "disconnected" && !this.login) return this.view();
    this.status = "draining";
    this.authUrl = undefined;
    this.login?.controller.abort();
    const work = (async () => {
      await this.login?.promise;
      this.login = undefined;
      if (this.record) {
        this.record.draining = true;
        await this.save(this.record);
      }
      await drain();
      await this.clearPending();
      if (this.record?.source === "private")
        await this.auth.logout(this.runtimeOptions(this.record));
      await this.save(null);
      this.record = null;
      this.status = "disconnected";
      this.message = undefined;
    })();
    this.operation = work;
    try {
      await work;
    } catch (e) {
      this.message = "退出尚未完成，请确认旧执行已停止后重试";
      throw e;
    } finally {
      this.operation = undefined;
    }
    return this.view();
  }
  async run(input: ExecutionInput, signal: AbortSignal) {
    const record = this.record;
    // Admission is handled by Runner. Already reserved work may finish during drain.
    if (!record || !["connected", "draining"].includes(this.status))
      throw new Error("Codex account is not connected");
    try {
      return await new CodexExecutor(this.runtimeOptions(record)).run(
        input,
        signal,
      );
    } catch (error) {
      if (error instanceof Error && /account changed/.test(error.message)) {
        record.draining = true;
        this.status = "draining";
        this.message = "账号已变更或登录失效，请退出连接后重新登录";
        await this.save(record);
      }
      throw error;
    }
  }
  async close() {
    this.closing = true;
    this.login?.controller.abort();
    await this.login?.promise;
    await this.operation;
  }
}
