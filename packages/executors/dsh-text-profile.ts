import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { z } from 'zod';
import type { DshOptions } from './dsh.ts';
import {modelIdSchema} from '../domain/agent-models.ts';

const absolute = z.string().min(1).refine((x) => isAbsolute(x) && !/[\0\r\n]/.test(x));
const schema = z.object({
  runtime: absolute,
  model:modelIdSchema.default('deepseek-v4-pro'),
  account: z.discriminatedUnion('kind', [
    z.object({kind: z.literal('local'), path: absolute}).strict(),
    z.object({kind: z.literal('test'), endpoint: z.string().refine((value) => {
      try { const u = new URL(value); return u.protocol === 'http:' && u.hostname === '127.0.0.1' && !!u.port && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash; }
      catch { return false; }
    })}).strict(),
  ]),
  maxTokens: z.number().int().min(1).max(4096),
  timeoutMs: z.number().int().min(100).max(600_000).default(30_000),
}).strict();
export type DshTextOptions = z.input<typeof schema>;

async function verifyCohort(anchor: string) {
  const visited = new Set<string>();
  const pending = [anchor];
  try {
    while (pending.length) {
      const file = await realpath(pending.pop()!);
      if (visited.has(file)) continue;
      visited.add(file);
      const pkg = JSON.parse(await readFile(file, 'utf8'));
      // The alpha root declares ^0.1.2-alpha.2 for its siblings; npm may
      // legitimately resolve the later release candidate within that range.
      if (!['0.1.2-alpha.2','0.1.2-rc.1'].includes(pkg.version)) throw new Error('unverified DSH dependency version');
      const require = createRequire(file);
      for (const name of Object.keys(pkg.dependencies ?? {}))
        if (name.startsWith('@deepseek-ai/dsh')) pending.push(require.resolve(name + '/package.json'));
    }
  } catch { throw new Error('DSH runtime dependency cohort is not verified'); }
}

/** macOS launch with a fresh Harness home for each attempt. Code tools are
 * confined to the prepared repository snapshot; the text path remains tool-free.
 * This does not restrict filesystem reads or network traffic.
 */
export async function prepareDshTextRuntime(raw: DshTextOptions, codeWorkspace?: string): Promise<{root: string; options: DshOptions}> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error('DSH text configuration is invalid');
  if (process.platform !== 'darwin') throw new Error('DSH text runtime requires macOS containment');
  const value = parsed.data;
  if(codeWorkspace){
    if(!isAbsolute(codeWorkspace))throw new Error('DSH code workspace must be absolute');
    const stat=await lstat(codeWorkspace);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('DSH code workspace is not a regular directory');
    codeWorkspace=await realpath(codeWorkspace);
  }
  const runtime = await realpath(value.runtime);
  const manifest = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8'));
  if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== '0.1.2-alpha.2')
    throw new Error('DSH text runtime version is not verified');
  await verifyCohort(join(runtime, 'package.json'));
  const cli = await realpath(join(runtime, 'lib/bin.js'));
  if (!cli.startsWith(runtime + '/')) throw new Error('DSH runtime entry escapes installation');
  let credentialFile: string | undefined;
  if (value.account.kind === 'local') {
    const st = await lstat(value.account.path);
    if (!st.isFile() || st.isSymbolicLink() || st.mode & 0o077)
      throw new Error('DSH local credential store is not a private regular file');
    credentialFile = await realpath(value.account.path);
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mas-dsh-text-')));
  try {
    const home = join(root, 'home');
    const work = codeWorkspace??join(root, 'work');
    const scratch=join(root,'work');
    const profile = join(home, 'profiles/mas-text');
    await mkdir(profile, {recursive: true, mode: 0o700});
    await mkdir(scratch, {mode: 0o700});
    if (!credentialFile) {
      credentialFile = join(root, 'fixture-credentials.yaml');
      await writeFile(credentialFile, JSON.stringify({version: 1, refs: {DEEPSEEK_API_KEY: 'mas-local-fixture-not-a-real-key'}}), {mode: 0o600, flag: 'wx'});
    }
    const guard = fileURLToPath(new URL('./dsh-text-guard.mjs', import.meta.url));
    const entries = [
      {id: 'mas-startup', name: '@deepseek-ai/dsh-sdk-app', config: {profile: 'mas-text'}},
      {id: 'mas-sdk', name: '@deepseek-ai/dsh-sdk-jsonrpc-server', inject: ['sdkAppStartup', 'loader', 'masTextPolicy'], config: {maxTokensAsSuccess: false}},
      {id: 'mas-credentials', name: '@deepseek-ai/dsh-credentials-local', config: {path: credentialFile, watch: false}},
      {id: 'mas-llm', name: '@deepseek-ai/dsh-llm-deepseek', config: {
        apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: value.account.kind === 'local' ? 'https://api.deepseek.com' : value.account.endpoint,
        thinking: 'disabled', maxTokens: value.maxTokens, streamIdleTimeoutMs: value.timeoutMs,
        retryPolicy: {mode: 'normal', maxRetries: 0},
      }},
      ...(codeWorkspace?[
        {id:'mas-subprocess',name:'@deepseek-ai/dsh-subprocess-local'},
        {id:'mas-sandbox',name:'@deepseek-ai/dsh-sandbox-local'},
        {id:'mas-sandbox-policy',name:'@deepseek-ai/dsh-sandbox-policy',config:{mode:'workspace-write',workspaceRoot:work}},
        {id:'mas-bash',name:'@deepseek-ai/dsh-bash-sandbox',config:{cwd:work,timeoutMs:120_000}},
      ]:[]),
      {id: 'mas-spine', name: '@deepseek-ai/dsh-agent-spine-demo', config: {
        includeHarnessIdentity: false, includeRuntimeContext: false,
        persona: codeWorkspace?'Complete the supplied task in the isolated repository snapshot. Use the available shell to inspect, edit and test files. Report actual changes and checks. Do not claim actions you did not perform.':'Complete the supplied task. No tools are available. Return only the requested final answer; do not claim to have edited files or run commands.',
        workspaceContext: codeWorkspace?{maxBytes:4096}:false, skills: {enabled: false}, toolBash: codeWorkspace?{enableRunInBackground:false}:false, toolJobs: false, goals: false, agents: [],
      }},
      {id: 'mas-guard', name: guard, inject: ['tools', 'credentials'],config:{mode:codeWorkspace?'code':'text'}},
    ];
    await writeFile(join(profile, 'package.json'), JSON.stringify({name: 'mas-owned-text-profile', private: true, type: 'module', dsh: {profile: {bundles: [], patchReload: 'startup'}}}), {mode: 0o600, flag: 'wx'});
    await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([{insert: entries}]), {mode: 0o600, flag: 'wx'});
    const config = join(root, 'launch.json');
    await writeFile(config, JSON.stringify({cli, home, work, scratch}), {mode: 0o600, flag: 'wx'});
    const node = await realpath(process.execPath);
    // Literal path quoting prevents policy injection. Write permission is scoped
    // to this newly created attempt only; native credential migration is denied.
    const policy = `(version 1)(allow default)(deny file-write*)(allow file-write* (subpath ${JSON.stringify(root)}))${codeWorkspace?`(allow file-write* (subpath ${JSON.stringify(work)}))`:'(deny process-fork)'}`;
    const launcher = fileURLToPath(new URL('./dsh-text-launch.mjs', import.meta.url));
    return {root, options: {command: '/usr/bin/sandbox-exec', args: ['-p', policy, node, launcher, config], provider: 'deepseek-official', model: value.model, maxTokens: value.maxTokens, timeoutMs: value.timeoutMs}};
  } catch (error) { await rm(root, {recursive: true, force: true}); throw error; }
}
