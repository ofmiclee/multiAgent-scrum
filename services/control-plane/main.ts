import { once } from "node:events";
import { createHash } from "node:crypto";
import { resolve, isAbsolute } from "node:path";
import {
  CodexConnection,
  acquireAccountLock,
} from "../runner/codex-connection.ts";
import { Repository } from "./repository.ts";
import { createApp } from "./http.ts";
import { Runner } from "../runner/runner.ts";
import { DemoExecutor } from "../../packages/executors/demo.ts";
import type { Executor } from "../../packages/domain/contracts.ts";
import { SnapshotStore } from "../runner/snapshots.ts";
import { DshConnection } from '../runner/dsh-connection.ts';
import { registerDshAgent } from '../runner/dsh-registration.ts';
import { RunnerDevices } from './runner-devices.ts';
import {RunnerTasks} from './runner-tasks.ts';

if (process.env.NODE_ENV === "production")
  throw new Error(
    "Local preview identities cannot run in production. Supply the production auth adapter first.",
  );
const port = Number(process.env.PORT ?? 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("PORT must be an unprivileged local port");
const repo = new Repository(
  process.env.DATABASE_URL,
  process.env.PREVIEW_WORKSPACE ?? "local-preview",
);
await repo.initialize();
const devices = process.env.ENABLE_RUNNER_DEVICES === '1' ? new RunnerDevices(repo) : undefined;
try { await devices?.initialize(); } catch(error) { await repo.close(); throw error; }
if(process.env.ENABLE_RUNNER_TASKS==='1'&&!devices){await repo.close();throw Error('ENABLE_RUNNER_TASKS requires ENABLE_RUNNER_DEVICES=1');}
if(process.env.ENABLE_RUNNER_DSH_TASKS==='1'&&process.env.ENABLE_RUNNER_TASKS!=='1'){await repo.close();throw Error('ENABLE_RUNNER_DSH_TASKS requires ENABLE_RUNNER_TASKS=1');}
const remoteTasks=process.env.ENABLE_RUNNER_TASKS==='1'?new RunnerTasks(repo,devices!,undefined,{allowDsh:process.env.ENABLE_RUNNER_DSH_TASKS==='1'}):undefined;
try{await remoteTasks?.initialize();}catch(error){await repo.close();throw error;}
const executors: Partial<Record<"demo" | "codex" | "dsh" | "claude-code", Executor>> = {
  demo: new DemoExecutor(),
};
let account: CodexConnection | undefined;
let releaseAccountLock: (() => Promise<void>) | undefined;
let dshAccount: DshConnection | undefined;
let releaseDshLock: (() => Promise<void>) | undefined;
let claudeCodeAvailable = false;
// Enable the connection UI, never silently turn a local login into execution consent.
if (process.env.ENABLE_CODEX === "1") {
  const command = process.env.CODEX_COMMAND;
  if (command && !isAbsolute(command))
    throw new Error("CODEX_COMMAND must be an absolute trusted executable");
  account = new CodexConnection(
    resolve(".runtime/codex-account"),
    process.env.LOCAL_RUNNER_USER ?? "owner",
    { command },
  );
  try {
    releaseAccountLock = await acquireAccountLock(account.root);
    await account.initialize();
  } catch (error) {
    await releaseAccountLock?.();
    await repo.close();
    throw error;
  }
  executors.codex = account;
}
if(process.env.ENABLE_DSH === '1') {
  try {
    const runtime=process.env.DSH_RUNTIME, credentials=process.env.DSH_CREDENTIAL_STORE;
    if(!runtime || !credentials) throw Error('DSH_RUNTIME and DSH_CREDENTIAL_STORE must be explicit absolute local paths');
    if(process.platform!=='darwin') throw Error('DSH text Runtime requires macOS containment');
    dshAccount=new DshConnection(resolve('.runtime/dsh-account'),process.env.LOCAL_RUNNER_USER??'owner',{runtime,credentials});
    releaseDshLock=await acquireAccountLock(dshAccount.root);
    await dshAccount.initialize();
    await repo.mutate(s=>registerDshAgent(s,dshAccount!.owner));
    executors.dsh=dshAccount;
  } catch(error) {
    await dshAccount?.close();await releaseDshLock?.();await account?.close();await releaseAccountLock?.();await repo.close();throw error;
  }
}
// Explicit experimental local preview; production Runner credentials are separate.
if (process.env.ENABLE_CLAUDE_CODE === "1") {
  try {
    if(process.env.CLAUDE_CODE_COMMAND&&!isAbsolute(process.env.CLAUDE_CODE_COMMAND))throw Error('Claude Code command must be an absolute trusted executable');
    const { probeClaudeCode, ClaudeCodeExecutor } = await import(
      "../../packages/executors/claude-code.ts"
    );
    const probe = await probeClaudeCode({
      command: process.env.CLAUDE_CODE_COMMAND,
    });
    if (probe.available && probe.authenticated) {
      claudeCodeAvailable = true;
      executors["claude-code"] = new ClaudeCodeExecutor({
        command: process.env.CLAUDE_CODE_COMMAND,
      });
      console.log(
        `Claude Code ${probe.version} available (authenticated: ${probe.authenticated})`,
      );
    } else {
      console.warn("Claude Code CLI or authenticated account not available, skipping");
    }
  } catch (error) {
    console.warn("Failed to initialize experimental Claude Code executor");
  }
}
const snapshots = new SnapshotStore(
  resolve(
    ".runtime",
    `code-snapshots-${createHash("sha256").update(repo.key).digest("hex").slice(0, 24)}`,
  ),
);
const runner = new Runner(repo, executors, undefined, snapshots, {
  available: (a) => {
    if (a.provider === 'dsh') return !!dshAccount?.available(a.ownerId);
    if (a.provider === 'claude-code') return claudeCodeAvailable&&a.ownerId===(process.env.LOCAL_RUNNER_USER??'owner');
    return a.provider !== "codex" || !!account?.available(a.ownerId);
  },
  accepting: (a) => {
    if (a.provider === 'dsh') return !!dshAccount?.accepting(a.ownerId);
    if (a.provider === 'claude-code') return claudeCodeAvailable&&a.ownerId===(process.env.LOCAL_RUNNER_USER??'owner');
    return a.provider !== "codex" || !!account?.accepting(a.ownerId);
  },
});
try {
  await runner.start();
} catch (error) {
  await dshAccount?.close();await releaseDshLock?.();
  await account?.close();
  await releaseAccountLock?.();
  await repo.close();
  throw error;
}
const app = createApp(
  repo,
  () => ({
    codexAvailable: !!account,
    codexVersion: null,
    claudeCodeAvailable,
    running: runner.running,
  }),
  undefined,
  snapshots,
  account
    ? { connection: account, drain: () => runner.drainProvider("codex") }
    : undefined,
  dshAccount ? {connection:dshAccount,drain:()=>runner.drainProvider('dsh')} : undefined,
  devices,
  remoteTasks,
);
app.listen(port, "127.0.0.1");
try {
  await once(app, "listening");
} catch (error) {
  await runner.stop();
  await dshAccount?.close();await releaseDshLock?.();
  await account?.close();
  await releaseAccountLock?.();
  await repo.close();
  throw error;
}
console.log(`MultiAgent Scrum local preview: http://127.0.0.1:${port}`);
console.log(
  "Local test identities only. Demo Agents simulate work; cloud and public access are disabled.",
);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  app.close();
  await runner.stop();
  await dshAccount?.close();await releaseDshLock?.();
  await account?.close();
  await releaseAccountLock?.();
  app.closeAllConnections();
  await repo.close();
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
