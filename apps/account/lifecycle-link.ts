import {runnerReturnId} from './runner-return';
import {agentDraftId} from './agent-return';
export type LifecycleLink = {kind: 'verify-email' | 'reset-password'; token: string} | {kind: 'invalid'} | null;

export function takeLifecycleLink(location: Pick<Location, 'hash' | 'pathname' | 'search'>, history: Pick<History, 'replaceState'>): LifecycleLink {
  const fragment = location.hash;
  if (!fragment) return null;
  // Hierarchy routes contain only navigation IDs, not email lifecycle tokens.
  if(fragment.startsWith('#/'))return null;
  if(/^#join-invite=[a-f0-9]{64}$/.test(fragment))return null;
  if(fragment==='#devices'||fragment==='#agents'||runnerReturnId(fragment)||agentDraftId(fragment))return null;
  // Synchronous: scrub the current history entry before parsing or networking.
  history.replaceState(null, '', location.pathname + location.search);
  const entries = [...new URLSearchParams(fragment.slice(1)).entries()];
  if (entries.length !== 1) return {kind: 'invalid'};
  const [kind, token] = entries[0];
  if ((kind !== 'verify-email' && kind !== 'reset-password') || !token || token.length > 4096 || /\s/.test(token)) return {kind: 'invalid'};
  return {kind, token};
}
