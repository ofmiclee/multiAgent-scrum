import {parseArgs} from 'node:util';
import {rm} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {prepareDshTextRuntime, type DshTextOptions} from './dsh-text-profile.ts';
import {DshExecutor} from './dsh.ts';
import {DshProcess, isObject} from './dsh-process.ts';
import {ExecutorStopUnconfirmed} from '../domain/execution-errors.ts';

export function parseDshProbeOptions(args: string[]): DshTextOptions & {modelCall: boolean} {
  let values;
  try {
    ({values} = parseArgs({args, options: {runtime: {type: 'string'}, 'local-credentials': {type: 'string'}, 'allow-model-call': {type: 'boolean'}}, strict: true, allowPositionals: false}));
  } catch { throw new Error('DSH probe configuration is invalid'); }
  if (!values.runtime || !isAbsolute(values.runtime)) throw new Error('DSH probe configuration is invalid');
  if (values['allow-model-call'] && !values['local-credentials']) throw new Error('DSH model probe requires explicit local credentials');
  return {runtime: values.runtime, account: values['local-credentials'] ? {kind: 'local', path: values['local-credentials']} : {kind: 'test', endpoint: 'http://127.0.0.1:1'}, maxTokens: 128, modelCall: values['allow-model-call'] === true};
}

/** Manual acceptance command only; never registered in scheduling or HTTP.
 * Default handshake cannot prompt. Paid mode has one fixed non-sensitive task.
 */
export async function probeDshText(raw: DshTextOptions & {modelCall: boolean}) {
  const {modelCall, ...options} = raw;
  if (modelCall && options.account.kind !== 'local') throw new Error('DSH model probe requires explicit local credentials');
  const prepared = await prepareDshTextRuntime(options);
  const cwd = join(prepared.root, 'work');
  let stopped = false;
  try {
    if (modelCall) {
      const result = await new DshExecutor(prepared.options).run({taskId: 'manual-dsh-smoke', attemptId: 'single-prompt', fence: 1, title: 'Connection check', description: 'Reply with exactly: DSH connection OK', acceptance: 'Reply contains the requested text. Do not invoke tools.', feedback: [], cwd}, new AbortController().signal, () => { stopped = true; });
      if (result.summary.trim() !== 'DSH connection OK') throw new Error('DSH smoke response did not match');
      return {handshake: true, credentials: 'local-configured', modelCall: true, responseMatched: true};
    }
    const peer = new DshProcess(prepared.options.command, prepared.options.args, cwd);
    const timer = setTimeout(() => peer.fail(new Error('DSH probe timed out')), prepared.options.timeoutMs);
    try {
      const value = await Promise.race([peer.request('initialize', {cwd, provider: prepared.options.provider, model: prepared.options.model, maxTokens: prepared.options.maxTokens}), peer.failed]);
      if (!isObject(value.serverInfo) || value.serverInfo.name !== 'deepseek-harness-sdk-runtime') throw new Error('DSH probe identity mismatch');
      return {handshake: true, credentials: options.account.kind === 'local' ? 'local-configured' : 'fixture-only', modelCall: false};
    } finally {
      clearTimeout(timer);
      try {await peer.stop();} catch {throw new ExecutorStopUnconfirmed();}
      stopped = true;
    }
  } finally {
    // An unconfirmed shutdown must never trigger cleanup under a live process.
    if (stopped) await rm(prepared.root, {recursive: true, force: true});
  }
}
