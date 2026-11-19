import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import {
  ClaudeCodeExecutor,
  probeClaudeCode,
  readClaudeCodeAccount,
} from "../packages/executors/claude-code.ts";
import type { ExecutionInput } from "../packages/domain/contracts.ts";

// Exercise real spawn, stream parsing and group teardown without a model call
// or a dependency on the developer's local login.
async function fixture(t: TestContext, body: string) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "mas-claude-executor-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const command = join(cwd, "claude-fixture.mjs");
  await writeFile(command, `#!${process.execPath}
import {writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
const args=process.argv.slice(2);
const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const success={type:'result',subtype:'success',is_error:false,result:'完成',session_id:'session-1',uuid:'result-1',permission_denials:[],num_turns:1,duration_ms:12,duration_api_ms:10,total_cost_usd:0,usage:{},modelUsage:{}};
${body}
`, { mode: 0o700 });
  return { command, cwd };
}

const input = (cwd: string): ExecutionInput => ({
  taskId: "task-1", attemptId: "attempt-1", fence: 1,
  title: "检查任务", description: "检查当前输入", acceptance: "给出实际结果",
  feedback: ["保留先前反馈"], cwd,
});

test("Claude accepts a final frame without a newline and records native result identity", async t => {
  const f = await fixture(t, `emit({type:'system',subtype:'init',session_id:'session-1',model:'claude-sonnet-5'});
const bytes=Buffer.from(JSON.stringify(success));
const split=bytes.indexOf(Buffer.from('完成'))+1;
process.stdout.write(bytes.subarray(0,split));setTimeout(()=>process.stdout.end(bytes.subarray(split)),10);`);
  const result = await new ClaudeCodeExecutor(f).run(input(f.cwd), new AbortController().signal);
  assert.deepEqual(result, { summary: "完成", artifacts: [], checksPassed: false,
    nativeSession: { threadId: "session-1", turnId: "result-1" } });
});

test("Claude uses cwd and selected model with noninteractive restricted file tools", async t => {
  const f = await fixture(t, `success.result=JSON.stringify({cwd:process.cwd(),args});emit(success);`);
  const result = await new ClaudeCodeExecutor({ ...f, model: "haiku", permissionMode: "acceptEdits" })
    .run({ ...input(f.cwd), model: "claude-sonnet-5" }, new AbortController().signal);
  const report = JSON.parse(result.summary);
  assert.equal(report.cwd, f.cwd);
  assert.ok(!report.args.includes("--cwd"));
  assert.equal(report.args[report.args.indexOf("--model") + 1], "claude-sonnet-5");
  assert.equal(report.args[report.args.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.equal(report.args[report.args.indexOf("--permission-prompts") + 1], "none");
  assert.ok(report.args.includes("--safe-mode"));
  assert.ok(report.args.includes("--restricted"));
  assert.ok(report.args.includes("--strict-mcp-config"));
  assert.equal(report.args[report.args.indexOf("--tools") + 1], "Read,Glob,Grep,Edit,Write");
  assert.ok(report.args.at(-1).includes("保留先前反馈"));
});

test("Claude assessment has no tools even when file edits are configured", async t => {
  const f = await fixture(t, `success.result=JSON.stringify(args);emit(success);`);
  const result = await new ClaudeCodeExecutor({ ...f, permissionMode: "acceptEdits" })
    .run({ ...input(f.cwd), purpose: "assess" }, new AbortController().signal);
  const args = JSON.parse(result.summary);
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
});

test("Claude returns success only after natural exit and background cleanup", async t => {
  const f = await fixture(t, `emit(success);setTimeout(()=>writeFileSync('finished','done'),50);`);
  await new ClaudeCodeExecutor(f).run(input(f.cwd), new AbortController().signal);
  assert.equal(await readFile(join(f.cwd, "finished"), "utf8"), "done");
});

for (const [name, body, error] of [
  ["nonzero exit after success", "emit(success);process.exitCode=7;", /exited.*7/],
  ["normal exit without a result", "emit({type:'system',terminal_reason:'completed'});", /without.*result|before.*completion/],
  ["invalid JSON", "process.stdout.write('invalid-json\\n');", /invalid.*JSON|invalid.*protocol/],
  ["invalid event envelope", "emit(null);", /invalid.*protocol/],
  ["error subtype despite a false is_error", "emit({...success,subtype:'error_max_turns'});", /error_max_turns/],
  ["reported API failure", "emit({...success,is_error:true});", /execution failed/],
  ["session mismatch", "emit({type:'system',subtype:'init',session_id:'other'});emit(success);", /session/],
  ["missing native result identity", "delete success.uuid;emit(success);", /identifier|identity/],
  ["permission denial inside a result", "emit({...success,permission_denials:[{tool_name:'Bash',tool_use_id:'tool-1',tool_input:{command:'npm test'}}]});", /permission|approval/],
  ["permission denial event", "emit({type:'system',subtype:'permission_denied'});emit(success);", /permission|approval/],
  ["incomplete terminal reason", "emit({...success,terminal_reason:'tool_deferred'});", /tool_deferred/],
] as const) {
  test(`Claude rejects ${name}`, async t => {
    const f = await fixture(t, body);
    await assert.rejects(new ClaudeCodeExecutor({ ...f, timeoutMs: 1000 })
      .run(input(f.cwd), new AbortController().signal), error);
  });
}

test("Claude times out after a result if the process still runs", async t => {
  const f = await fixture(t, `emit(success);writeFileSync('result-sent','yes');setInterval(()=>{},1000);`);
  await assert.rejects(new ClaudeCodeExecutor({ ...f, timeoutMs: 1000 })
    .run(input(f.cwd), new AbortController().signal), /timed out/);
  assert.equal(await readFile(join(f.cwd, "result-sent"), "utf8"), "yes");
});

test("Claude cancellation waits for the entire owned process group to stop", async t => {
  const f = await fixture(t, `const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
writeFileSync('pids',JSON.stringify([process.pid,child.pid]));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
  const controller = new AbortController();
  const running = new ClaudeCodeExecutor({ ...f, timeoutMs: 2000 }).run(input(f.cwd), controller.signal);
  void running.catch(() => {});
  let pids: number[] | undefined;
  for (let count = 0; count < 100 && !pids; count++) {
    pids = await readFile(join(f.cwd, "pids"), "utf8").then(JSON.parse).catch(() => undefined);
    if (!pids) await delay(10);
  }
  assert.ok(pids, "child process must have started before cancellation");
  controller.abort();
  await assert.rejects(running, /cancelled/);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("Claude validates inputs before starting the CLI", async () => {
  const executor = new ClaudeCodeExecutor({ command: "/missing-claude-command" });
  await assert.rejects(executor.run(input("relative"), new AbortController().signal), /absolute directory/);
  const code: NonNullable<ExecutionInput["code"]> = { projectId: "p", repository: { id: "a", commit: "a", fileCount: 0, createdAt: "" }, dependencies: [] };
  await assert.rejects(executor.run({ ...input(tmpdir()), purpose: "assess", code }, new AbortController().signal), /Assessment cannot contain code input/);
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(executor.run(input(tmpdir()), stopped.signal), /cancelled/);
  await assert.rejects(new ClaudeCodeExecutor({ timeoutMs: 0 }).run(input(tmpdir()), new AbortController().signal), /positive/);
});

test("Claude process startup failures settle without waiting for the task timeout", async () => {
  await assert.rejects(new ClaudeCodeExecutor({ command: "/missing-claude-command", timeoutMs: 1000 })
    .run(input(tmpdir()), new AbortController().signal), /process.*start|process error/);
});

test("Claude does not forward workflow secrets or Node injection settings", async t => {
  const saved = { database: process.env.DATABASE_URL, nodeOptions: process.env.NODE_OPTIONS };
  process.env.DATABASE_URL = "workflow-private-value";
  process.env.NODE_OPTIONS = "--no-warnings";
  try {
    const f = await fixture(t, `success.result=JSON.stringify({database:process.env.DATABASE_URL??null,nodeOptions:process.env.NODE_OPTIONS??null});emit(success);`);
    const result = await new ClaudeCodeExecutor(f).run(input(f.cwd), new AbortController().signal);
    assert.deepEqual(JSON.parse(result.summary), { database: null, nodeOptions: null });
  } finally {
    if (saved.database === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.database;
    if (saved.nodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = saved.nodeOptions;
  }
});

test("Claude probe distinguishes an installed unauthenticated CLI", async t => {
  const f = await fixture(t, `if(args[0]==='--version')console.log('2.1.296 (Claude Code)');else {console.log(JSON.stringify({loggedIn:false,authMethod:'none'}));process.exitCode=1;}`);
  assert.deepEqual(await probeClaudeCode(f), { available: true, version: "2.1.296", authenticated: false });
  assert.equal(await readClaudeCodeAccount(f), null);
});

for (const [auth, account] of [
  [{ loggedIn: true, authMethod: "api_key" }, { type: "apiKey" }],
  [{ loggedIn: true, authMethod: "claude.ai", email: "member@example.com" }, { type: "anthropic", email: "member@example.com" }],
] as const) {
  test(`Claude reads confirmed ${auth.authMethod} account metadata`, async t => {
    const f = await fixture(t, `if(args[0]==='--version')console.log('2.1.296 (Claude Code)');else if(args[0]==='auth'&&args[1]==='status')console.log(${JSON.stringify(JSON.stringify(auth))});else process.exitCode=1;`);
    assert.deepEqual(await probeClaudeCode(f), { available: true, version: "2.1.296", authenticated: true });
    assert.deepEqual(await readClaudeCodeAccount(f), account);
  });
}

test("Claude probe handles unavailable commands and malformed auth status without inventing an account", async t => {
  assert.deepEqual(await probeClaudeCode({ command: "/missing-claude-command" }), { available: false, version: null, authenticated: false });
  const f = await fixture(t, `if(args[0]==='--version')console.log('2.1.296 (Claude Code)');else console.log('not-json');`);
  assert.equal((await probeClaudeCode(f)).authenticated, false);
  assert.equal(await readClaudeCodeAccount(f), null);
});
