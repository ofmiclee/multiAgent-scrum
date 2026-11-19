import type {RunnerProfile} from '../../packages/domain/runner-protocol.ts';

export const localIdentityMigrations=[
  '001-identity.sql','002-business-onboarding.sql','003-business-projects.sql','004-business-members.sql',
  '005-business-stories.sql','006-business-task-publications.sql','007-business-runner-connections.sql',
  '008-business-agents.sql','009-business-coordinator.sql','010-business-execution.sql',
  '011-business-device-launch.sql','012-business-named-agents.sql','013-business-agent-device-creation.sql',
  '014-business-codex-code.sql',
  '015-business-code-repositories.sql',
  '016-agent-models.sql','017-attempt-model.sql',
  '018-story-assistance.sql','019-business-boards.sql','020-durable-artifacts.sql',
  '021-agent-routing.sql','022-task-rework.sql','023-organization-project-hierarchy.sql','024-task-comments.sql',
  '025-membership-invitations.sql',
  '026-body-images-direct-tasks.sql',
  '027-personal-profile.sql',
  '028-organization-avatar.sql',
  '029-project-files.sql','030-agent-model-catalog.sql','031-agent-model-catalog-gpt-6.sql','032-business-agent-soft-delete.sql',
  '033-retire-default-agents.sql','034-directory-picker.sql','035-agent-credentials.sql','036-runner-local-config.sql',
  '037-task-conversation.sql',
  '038-task-messages.sql',
  '039-task-retry.sql',
] as const;

export function resolveAccountRunnerProfiles(environment:NodeJS.ProcessEnv):RunnerProfile[]{
  const taskChannel=environment.ENABLE_ACCOUNT_RUNNER_TASKS==='1';
  const profiles:RunnerProfile[]=taskChannel?['demo']:[];
  if(environment.ENABLE_ACCOUNT_RUNNER_DSH_TASKS==='1'){
    if(!taskChannel)throw Error('Formal DSH channel requires explicit task-channel opt-in');
    profiles.push('dsh-text');
  }
  if(environment.ENABLE_ACCOUNT_RUNNER_CODEX_TASKS==='1'){
    if(!taskChannel)throw Error('Formal Codex channel requires explicit task-channel opt-in');
    profiles.push('codex-code');
  }
  return profiles;
}
