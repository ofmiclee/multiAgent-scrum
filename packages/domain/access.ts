import type {Project, State} from './contracts.ts';

/** Business authorization only. The caller's identity must be authenticated separately. */
export function isOrganizationMember(s: State, userId: string, organizationId: string): boolean {
  if (!organizationId || !s.users.some(u => u.id === userId) ||
      !s.organizations?.some(o => o.id === organizationId)) return false;
  const memberships = s.organizationMemberships?.filter(m =>
    m.userId === userId && m.organizationId === organizationId) ?? [];
  // Duplicate/conflicting records fail closed rather than selecting an active copy.
  return memberships.length === 1 && memberships[0].status === 'active';
}

export function isProjectMember(s: State, userId: string, project: Project | undefined): boolean {
  return !!project && project.memberIds.includes(userId) &&
    isOrganizationMember(s, userId, project.organizationId);
}
