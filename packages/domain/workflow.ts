import { randomUUID } from "node:crypto";
import {
  enqueueCoordination,
  coordinationWaitingReason,
  expireCoordination,
} from "./coordination.ts";
import { coordinatorReadiness } from "./coordinator-readiness.ts";
import { taskAdmission } from "./task-admission.ts";
import { isOrganizationMember, isProjectMember } from './access.ts';
import {
  requiresCodeWorkspace,
  validateCodeContext,
} from "./code-execution.ts";
import type {
  State,
  Task,
  Story,
  DraftTask,
  Agent,
  CodeChanges,
  ExecutionResult,
} from "./contracts.ts";

export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
const deny = () => {
  throw new DomainError("forbidden", "没有项目或资源操作权限", 403);
};
const iso = (at = Date.now()) => new Date(at).toISOString();
const id = (prefix: string) => `${prefix}-${randomUUID()}`;
const active = (t: Task) => t.status === "assigned" || t.status === "running";
export function member(s: State, user: string, projectId: string) {
  const p = s.projects.find((p) => p.id === projectId);
  if (!p || !isProjectMember(s, user, p)) return deny();
  return p;
}
export function taskFor(s: State, user: string, taskId: string) {
  const t = s.tasks.find((t) => t.id === taskId);
  if (!t) throw new DomainError("not_found", "任务不存在", 404);
  member(s, user, t.projectId);
  return t;
}
function event(
  s: State,
  projectId: string,
  type: string,
  message: string,
  taskId?: string,
) {
  s.events.push({
    id: id("event"),
    projectId,
    taskId,
    type,
    message,
    at: iso(),
  });
  if (s.events.length > 2000) s.events.splice(0, s.events.length - 2000);
}
function text(value: string, label: string, max = 20000) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new DomainError("invalid", `${label}不能为空且不能超长`);
  return value.trim();
}
export function createSeed(): State {
  const createdAt = iso();
  return {
    organizations: [{id: 'org-preview', name: '本地测试组织'}],
    organizationMemberships: ['owner', 'teammate', 'outsider'].map(userId => ({
      organizationId: 'org-preview', userId, status: 'active' as const,
    })),
    coordinationJobs: [],
    revision: 0,
    nextFence: 1,
    commands: {},
    users: [
      { id: "owner", name: "林 · 项目负责人", maxConcurrency: 1 },
      { id: "teammate", name: "陈 · 协作成员", maxConcurrency: 1 },
      { id: "outsider", name: "周 · 未加入项目", maxConcurrency: 1 },
    ],
    projects: [
      {
        id: "project-demo",
        organizationId: 'org-preview',
        name: "产品实验室",
        description: "本地协作演示 · 所有身份与执行成果均为测试数据",
        ownerId: "owner",
        memberIds: ["owner", "teammate"],
        boardIds: ["board-demo"],
        createdAt,
      },
    ],
    boards: [{ id: "board-demo", projectId: "project-demo", name: "默认看板" }],
    stories: [],
    tasks: [],
    events: [],
    agents: [
      {
        id: "agent-owner",
        name: "林的演示 Agent",
        ownerId: "owner",
        deviceId: "local-demo-a",
        provider: "demo",
        capabilities: ["coding", "writing"],
        projectIds: ["project-demo"],
        maxConcurrency: 1,
        enabled: true,
        online: true,
      },
      {
        id: "agent-teammate",
        name: "陈的演示 Agent",
        ownerId: "teammate",
        deviceId: "local-demo-b",
        provider: "demo",
        capabilities: ["coding", "writing"],
        projectIds: ["project-demo"],
        maxConcurrency: 1,
        enabled: true,
        online: true,
      },
      {
        id: "agent-codex",
        name: "本机 Codex（需显式启用）",
        ownerId: "owner",
        deviceId: "local-codex",
        provider: "codex",
        capabilities: ["coding", "writing"],
        projectIds: [],
        maxConcurrency: 1,
        enabled: false,
        online: false,
      },
    ],
  };
}
export function createProject(
  s: State,
  user: string,
  name: string,
  description = "",
  organizationId?: string,
) {
  if (!s.users.some((u) => u.id === user)) return deny();
  const memberships = (s.organizations ?? []).filter(o => isOrganizationMember(s, user, o.id));
  const selectedOrganization = organizationId ?? (memberships.length === 1 ? memberships[0].id : undefined);
  if (!selectedOrganization || !isOrganizationMember(s, user, selectedOrganization)) return deny();
  const p = {
    organizationId: selectedOrganization,
    id: id("project"),
    name: text(name, "项目名称", 120),
    description,
    ownerId: user,
    memberIds: [user],
    boardIds: [id("board")],
    createdAt: iso(),
  };
  s.projects.push(p);
  s.boards.push({ id: p.boardIds[0], projectId: p.id, name: "默认看板" });
  event(s, p.id, "project.created", "创建项目及默认看板");
  return p;
}
export function addMember(
  s: State,
  user: string,
  projectId: string,
  targetId: string,
) {
  const p = member(s, user, projectId);
  if (p.ownerId !== user || !isOrganizationMember(s, targetId, p.organizationId))
    return deny();
  if (!p.memberIds.includes(targetId)) {
    p.memberIds.push(targetId);
    event(s, p.id, "member.added", "加入一位组织正式成员");
  }
}
export function createBoard(
  s: State,
  user: string,
  projectId: string,
  name: string,
) {
  const p = member(s, user, projectId);
  if (p.ownerId !== user) return deny();
  const b = { id: id("board"), projectId, name: text(name, "看板名称", 120) };
  s.boards.push(b);
  p.boardIds.push(b.id);
  return b;
}
export function createStory(
  s: State,
  user: string,
  data: Pick<Story, "projectId" | "boardId" | "title" | "description">,
) {
  member(s, user, data.projectId);
  if (
    !s.boards.some(
      (b) => b.id === data.boardId && b.projectId === data.projectId,
    )
  )
    return deny();
  const story: Story = {
    ...data,
    title: text(data.title, "故事标题", 200),
    id: id("story"),
    published: false,
    taskIds: [],
    createdAt: iso(),
  };
  s.stories.push(story);
  event(s, story.projectId, "story.created", `记录故事：${story.title}`);
  return story;
}
export function publishStory(
  s: State,
  user: string,
  storyId: string,
  drafts: DraftTask[],
) {
  const story = s.stories.find((x) => x.id === storyId);
  if (!story) return deny();
  member(s, user, story.projectId);
  if (story.published)
    throw new DomainError("conflict", "故事已经发布，不能重复发布", 409);
  if (!drafts.length || drafts.length > 50)
    throw new DomainError("invalid", "一次发布 1–50 项任务");
  const visited = new Set<number>();
  const visiting = new Set<number>();
  function visit(i: number) {
    if (!Number.isInteger(i) || i < 0 || i >= drafts.length || visiting.has(i))
      throw new DomainError("invalid", "依赖无效或存在依赖循环");
    if (visited.has(i)) return;
    visiting.add(i);
    for (const dep of drafts[i].dependsOnIndexes) visit(dep);
    visiting.delete(i);
    visited.add(i);
  }
  drafts.forEach((d, i) => {
    text(d.title, "任务标题", 200);
    text(d.acceptance, "验收标准");
    visit(i);
  });
  const ids = drafts.map(() => id("task"));
  const tasks: Task[] = drafts.map((d, i) => ({
    id: ids[i],
    projectId: story.projectId,
    boardId: story.boardId,
    storyId,
    title: d.title.trim(),
    description: d.description,
    acceptance: d.acceptance,
    capability: d.capability,
    priority: d.priority,
    dependsOn: [...new Set(d.dependsOnIndexes)].map((n) => ids[n]),
    status: "ready",
    responsibleUserId: null,
    agentId: null,
    attempts: [],
    result: null,
    error: null,
    feedback: [],
    maxAttempts: 3,
    reviewPolicy: d.reviewPolicy,
    createdAt: iso(),
    updatedAt: iso(),
    assessmentRequired: true,
    inputRevision: 1,
  }));
  s.tasks.push(...tasks);
  for (const task of tasks)
    enqueueCoordination(s, user, story.projectId, task.id, "assess");
  story.taskIds = ids;
  story.published = true;
  event(
    s,
    story.projectId,
    "story.published",
    `发布故事，生成 ${tasks.length} 项任务`,
  );
  return tasks;
}
export function editAgent(
  s: State,
  user: string,
  agentId: string,
  patch: Partial<
    Pick<Agent, "enabled" | "maxConcurrency" | "projectIds" | "difficultyRange">
  >,
) {
  const a = s.agents.find((a) => a.id === agentId);
  if (!a || a.ownerId !== user) return deny();
  if (patch.projectIds)
    for (const pid of patch.projectIds) member(s, user, pid);
  if (
    patch.maxConcurrency !== undefined &&
    (!Number.isInteger(patch.maxConcurrency) ||
      patch.maxConcurrency < 1 ||
      patch.maxConcurrency > 8)
  )
    throw new DomainError("invalid", "并发上限为 1–8");
  if (
    patch.difficultyRange &&
    (!Number.isInteger(patch.difficultyRange.min) ||
      !Number.isInteger(patch.difficultyRange.max) ||
      patch.difficultyRange.min < 1 ||
      patch.difficultyRange.max > 5 ||
      patch.difficultyRange.min > patch.difficultyRange.max)
  )
    throw new DomainError("invalid", "难度范围应为 1–5，最小值不能超过最大值");
  Object.assign(a, patch);
  expireCoordination(s, Date.now());
  return a;
}
export function schedule(
  s: State,
  now: number,
  stopping = new Set<string>(),
  stoppingOwners = new Set<string>(),
  blockedAgents = new Set<string>(),
  remoteRunnerId?: string,
): Task[] {
  blockedAgents = new Set([...blockedAgents, ...s.agents.filter(a =>
    remoteRunnerId ? !a.executionMode || a.deviceId !== remoteRunnerId : !!a.executionMode
  ).map(a=>a.id)]);
  const assigned: Task[] = [];
  for (const t of [...s.tasks].sort(
    (a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt),
  )) {
    if (stopping.has(t.id)) continue;
    const admission = taskAdmission(s, t, blockedAgents, stoppingOwners);
    if (!admission?.status.ready) continue;
    const p = s.projects.find((p) => p.id === t.projectId)!;
    const candidates = admission.candidates;
    // Least lifetime assignments first, then stable ID: predictable and avoids starvation.
    const count = (aid: string) =>
      s.tasks.reduce(
        (n, x) => n + x.attempts.filter((a) => a.agentId === aid).length,
        0,
      );
    candidates.sort(
      (a, b) => count(a.id) - count(b.id) || a.id.localeCompare(b.id),
    );
    const a = candidates[0];
    if (!a) continue;
    t.status = "assigned";
    t.agentId = a.id;
    t.responsibleUserId = a.ownerId;
    t.fence = s.nextFence++;
    t.leaseUntil = now + 30000;
    t.error = null;
    t.updatedAt = iso(now);
    t.attempts.push({
      id: id("attempt"),
      agentId: a.id,
      ownerId: a.ownerId,
      deviceId: a.deviceId,
      fence: t.fence,
      startedAt: iso(now),
    });
    event(s, p.id, "task.assigned", `自动分配给 ${a.name}`, t.id);
    assigned.push(t);
  }
  return assigned;
}
function leased(s: State, taskId: string, fence: number, now: number) {
  const t = s.tasks.find((t) => t.id === taskId);
  if (!t || !active(t) || t.fence !== fence || (t.leaseUntil ?? 0) <= now)
    throw new DomainError("stale_lease", "执行租约已失效，拒绝旧结果", 409);
  return t;
}
export function start(s: State, taskId: string, fence: number, now: number) {
  const t = leased(s, taskId, fence, now);
  if (t.status !== "assigned")
    throw new DomainError("conflict", "任务已经开始", 409);
  t.status = "running";
  t.updatedAt = iso(now);
  event(s, t.projectId, "task.started", "执行器开始处理任务", t.id);
}
export function heartbeat(
  s: State,
  taskId: string,
  fence: number,
  now: number,
) {
  leased(s, taskId, fence, now).leaseUntil = now + 30000;
}
function finish(t: Task, outcome: string, now: number) {
  Object.assign(t.attempts.at(-1)!, { finishedAt: iso(now), outcome });
  delete t.leaseUntil;
  t.updatedAt = iso(now);
}
export function report(
  s: State,
  taskId: string,
  fence: number,
  result: ExecutionResult,
  now: number,
  codeChanges?: CodeChanges,
) {
  const t = leased(s, taskId, fence, now);
  if (t.status !== "running")
    throw new DomainError("conflict", "任务尚未执行", 409);
  const boundCode = requiresCodeWorkspace(s, t);
  if (boundCode) {
    const context = t.attempts.at(-1)?.codeContext;
    if (
      !context ||
      !codeChanges ||
      codeChanges.repositorySnapshotId !== context.repositorySnapshotId
    )
      throw new DomainError(
        "code_context",
        "代码成果缺少 Runner 收集的快照记录",
        409,
      );
    validateCodeContext(s, t, context);
    t.attempts.at(-1)!.codeChanges = {
      id: codeChanges.id,
      repositorySnapshotId: codeChanges.repositorySnapshotId,
      fileCount: codeChanges.fileCount,
    };
  }
  t.result = { summary: result.summary, artifacts: result.artifacts };
  t.error = null;
  // These checks are runner-owned, never inferred from an Agent's prose.
  t.status =
    !boundCode &&
    t.reviewPolicy === "automatic" &&
    result.checksPassed &&
    result.artifacts.length > 0
      ? "done"
      : "review";
  finish(t, t.status, now);
  Object.assign(t.attempts.at(-1)!, t.result);
  if (result.nativeSession)
    t.attempts.at(-1)!.nativeSession = result.nativeSession;
  event(
    s,
    t.projectId,
    t.status === "done" ? "task.auto_accepted" : "task.reported",
    t.status === "done"
      ? "可验证检查通过，自动验收"
      : "成果已提交，等待人工验收",
    t.id,
  );
}
export function fail(
  s: State,
  taskId: string,
  fence: number,
  message: string,
  now: number,
) {
  const t = leased(s, taskId, fence, now);
  t.status = "failed";
  t.recoveryRequired = true;
  t.error = message;
  finish(t, "failed", now);
  event(s, t.projectId, "task.failed", message, t.id);
}
export function expire(s: State, now: number, all = false) {
  for (const t of s.tasks)
    if (active(t) && (all || (t.leaseUntil ?? 0) <= now)) {
      t.recoveryRequired = true;
      t.status = "failed";
      t.error = all
        ? "服务重启：旧执行结果未知。确认旧进程已停止后再重试。"
        : "租约过期：执行结果未知。确认旧进程已停止后再重试。";
      finish(t, "interrupted", now);
      event(s, t.projectId, "task.interrupted", t.error, t.id);
    }
}
function budget(t: Task) {
  if (t.attempts.length >= t.maxAttempts)
    throw new DomainError(
      "exhausted",
      "已达到 3 次执行上限，请重新拆解任务",
      409,
    );
}
export function review(
  s: State,
  user: string,
  taskId: string,
  decision: "approve" | "reject",
  feedback = "",
) {
  const t = taskFor(s, user, taskId);
  if (member(s, user, t.projectId).ownerId !== user) return deny();
  if (t.status !== "review")
    throw new DomainError("conflict", "当前任务不在待验收阶段", 409);
  if (decision === "approve") {
    t.status = "done";
    event(s, t.projectId, "task.accepted", "项目负责人验收通过", t.id);
  } else {
    budget(t);
    text(feedback, "返工意见");
    t.feedback.push(feedback);
    t.status = "ready";
    t.result = null;
    event(s, t.projectId, "task.rework", `退回返工：${feedback}`, t.id);
  }
  t.updatedAt = iso();
}
export function retry(s: State, user: string, taskId: string) {
  const t = taskFor(s, user, taskId);
  if (
    member(s, user, t.projectId).ownerId !== user &&
    t.responsibleUserId !== user
  )
    return deny();
  if (t.status !== "failed")
    throw new DomainError("conflict", "只有失败任务可以重试", 409);
  budget(t);
  t.recoveryRequired = false;
  t.status = "ready";
  t.error = null;
  t.result = null;
  t.updatedAt = iso();
  event(s, t.projectId, "task.retry", "人工确认旧进程已停止后重试", t.id);
}
export function acknowledgeStop(s: State, user: string, taskId: string) {
  const t = taskFor(s, user, taskId);
  if (
    member(s, user, t.projectId).ownerId !== user &&
    t.responsibleUserId !== user
  )
    return deny();
  if (t.status !== "failed" || !t.recoveryRequired)
    throw new DomainError("conflict", "当前任务无需解除执行隔离", 409);
  t.recoveryRequired = false;
  event(
    s,
    t.projectId,
    "task.stop_confirmed",
    "成员确认旧进程已停止，解除资源隔离；任务未重试",
    t.id,
  );
}
export function cancel(s: State, user: string, taskId: string) {
  const t = taskFor(s, user, taskId);
  if (
    member(s, user, t.projectId).ownerId !== user &&
    t.responsibleUserId !== user
  )
    return deny();
  if (!active(t))
    throw new DomainError("conflict", "只能取消已分配或执行中的任务", 409);
  t.status = "failed";
  t.recoveryRequired = true;
  t.error = "用户已取消。重试前请确认执行进程已停止。";
  finish(t, "cancelled", Date.now());
  event(s, t.projectId, "task.cancelled", t.error, t.id);
}
export function workspaceFor(s: State, user: string, blockedAgents = new Set<string>()) {
  const currentUser = s.users.find((u) => u.id === user);
  if (!currentUser) return deny();
  const organizations = (s.organizations ?? []).filter(o => isOrganizationMember(s, user, o.id));
  const organizationIds = new Set(organizations.map(o => o.id));
  const projects = s.projects.filter((p) => isProjectMember(s, user, p));
  const ids = new Set(projects.map((p) => p.id));
  const tasks = s.tasks.filter((x) => ids.has(x.projectId));
  return {
    mode: "local-preview" as const,
    revision: s.revision,
    currentUser,
    organizations,
    organizationMemberships: (s.organizationMemberships ?? []).filter(m =>
      organizationIds.has(m.organizationId) && isOrganizationMember(s, m.userId, m.organizationId)),
    users: s.users.filter(u => u.id === user || organizations.some(o => isOrganizationMember(s, u.id, o.id))),
    projects: projects.map(p=>({...p,coordinationReadiness:coordinatorReadiness(s,p,blockedAgents)})),
    boards: s.boards.filter((x) => ids.has(x.projectId)),
    stories: s.stories.filter((x) => ids.has(x.projectId)),
    tasks,
    taskDispatch: Object.fromEntries(
      tasks.flatMap((task) => {
        const admission = taskAdmission(s, task, blockedAgents);
        return admission ? [[task.id, admission.status]] : [];
      }),
    ),
    coordinationJobs: (s.coordinationJobs ?? [])
      .filter((j) => ids.has(j.projectId))
      .map((j) => ({ ...j, waitingReason: coordinationWaitingReason(s, j, blockedAgents) })),
    agents: s.agents
      .filter((a) => a.ownerId === user || projects.some(p =>
        a.projectIds.includes(p.id) && isProjectMember(s, a.ownerId, p)))
      .map((a) => ({
        ...a,
        projectIds: a.projectIds.filter((p) => ids.has(p)),
      })),
    events: s.events.filter((x) => ids.has(x.projectId)),
  };
}
