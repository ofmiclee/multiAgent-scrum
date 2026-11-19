import type {State} from '../../packages/domain/contracts.ts';
import {isOrganizationMember} from '../../packages/domain/access.ts';
import {DomainError, member} from '../../packages/domain/workflow.ts';

const deny = (): never => { throw new DomainError('forbidden','没有项目或资源操作权限',403); };
const field = (value: unknown, key: string): unknown =>
  value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;

/** Called under the command row lock, including cached replies. Route schemas
 * validate input before this read-authorization gate; workflow owns mutation rules. */
export function authorizeCommand(s: State, user: string, path: string, data: unknown, previous?: unknown) {
  if (!s.users.some(u => u.id === user)) deny();
  const project = (id: unknown) => {
    if (typeof id !== 'string') return deny();
    return member(s, user, id);
  };
  if (path === '/api/profile') return;
  if (path === '/api/projects') {
    if (previous !== undefined) { project(field(previous, 'id')); return; }
    const requested = field(data, 'organizationId');
    const choices = (s.organizations ?? []).filter(o => isOrganizationMember(s,user,o.id));
    if (requested !== undefined ? typeof requested !== 'string' || !isOrganizationMember(s,user,requested) : choices.length !== 1) deny();
    return;
  }
  if (path === '/api/stories') { project(field(data, 'projectId')); return; }
  const route = /^\/api\/(projects|stories|tasks|coordination|agents)\/([^/]+)(?:\/[^/]+)?$/.exec(path);
  if (!route) return deny();
  const [, kind, id] = route;
  if (kind === 'projects') { project(id); return; }
  if (kind === 'stories') { project(s.stories.find(x=>x.id===id)?.projectId); return; }
  if (kind === 'tasks') { project(s.tasks.find(x=>x.id===id)?.projectId); return; }
  if (kind === 'coordination') { project(s.coordinationJobs.find(x=>x.id===id)?.projectId); return; }
  const agent = s.agents.find(a=>a.id===id);
  if (!agent || agent.ownerId !== user) return deny();
  const grants = field(data, 'projectIds');
  if (Array.isArray(grants)) grants.forEach(project);
  // A cached Agent response can contain old project grants, unlike a fresh edit.
  const cachedGrants = field(previous, 'projectIds');
  if (Array.isArray(cachedGrants)) cachedGrants.forEach(project);
}
