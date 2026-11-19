import { randomUUID } from "node:crypto";
import { isProjectMember } from './access.ts';
import type {
  State,
  CoordinationJob,
  CoordinationKind,
  Assessment,
  CoordinationOutputCall,
} from "./contracts.ts";
import { DomainError, member, taskFor } from "./workflow.ts";
import { hasCapacity } from "./capacity.ts";
import { coordinatorReadiness } from "./coordinator-readiness.ts";
import {
  coordinationContext,
  coordinationInputHash,
  parseCoordinationResult,
} from "./coordination-results.ts";

const iso = (now = Date.now()) => new Date(now).toISOString();
export const MAX_COORDINATION_OUTPUT_CALLS = 4;
const outputCallCount = (job: CoordinationJob) =>
  job.outputCalls?.length ?? job.attemptHistory.length;
function owner(s: State, user: string, projectId: string) {
  const p = member(s, user, projectId);
  if (p.ownerId !== user)
    throw new DomainError("forbidden", "仅项目 Owner 有操作权限", 403);
  return p;
}
function jobFor(s: State, user: string, id: string) {
  const j = s.coordinationJobs.find((j) => j.id === id);
  if (!j) throw new DomainError("not_found", "协调工作不存在", 404);
  owner(s, user, j.projectId);
  return j;
}
function failed(
  j: CoordinationJob,
  message: string,
  now: number,
  quarantine = true,
) {
  j.status = "failed";
  j.error = message;
  j.recoveryRequired = quarantine;
  j.updatedAt = iso(now);
  delete j.leaseUntil;
  const attempt = j.attemptHistory.at(-1);
  for (const call of j.outputCalls ?? []) {
    if (call.status === "running") {
      call.status = "failed";
      call.finishedAt = iso(now);
      call.issues = [message];
    }
  }
  if (attempt)
    Object.assign(attempt, {
      finishedAt: iso(now),
      outcome: "failed",
      summary: message,
    });
}
function pauseProject(
  s: State,
  j: CoordinationJob,
  reason: string,
  now: number,
) {
  const p = s.projects.find((p) => p.id === j.projectId);
  if (!p) return;
  p.coordinationPaused = {
    reason:
      reason.trim().slice(0, 500) || "协调执行失败，请 Owner 检查执行器账号",
    at: iso(now),
    jobId: j.id,
  };
}
export function configureCoordinator(
  s: State,
  user: string,
  projectId: string,
  agentId: string | null,
) {
  const p = owner(s, user, projectId);
  const a = s.agents.find((a) => a.id === agentId);
  if (a?.executionMode)
    throw new DomainError('unsupported', '独立文本执行器暂不支持项目协调', 409);
  if (
    agentId !== null &&
    (!a || a.ownerId !== p.ownerId || !a.projectIds.includes(p.id))
  )
    throw new DomainError(
      "forbidden",
      "协调 Agent 必须属于 Owner 且已授权项目",
      403,
    );
  if ((p.coordinatorAgentId ?? null) === agentId) return p;
  p.coordinatorAgentId = agentId ?? undefined;
  p.coordinationEpoch = (p.coordinationEpoch ?? 0) + 1;
  for (const j of s.coordinationJobs.filter((j) => j.projectId === p.id)) {
    if (j.status === "running")
      failed(j, "协调配置已替换或关闭，请确认旧进程停止后重试", Date.now());
    if (j.status === "queued") {
      j.agentId = agentId;
      j.epoch = p.coordinationEpoch;
    }
  }
  delete p.coordinationPaused;
  return p;
}
export function resumeCoordination(s: State, user: string, projectId: string) {
  const p = owner(s, user, projectId);
  const a = s.agents.find(
    (a) =>
      a.id === p.coordinatorAgentId &&
      a.ownerId === p.ownerId &&
      a.projectIds.includes(p.id),
  );
  if (!a)
    throw new DomainError(
      "conflict",
      "请先配置属于 Owner 且已授权项目的协调 Agent",
      409,
    );
  delete p.coordinationPaused;
  return p;
}
export function enqueueCoordination(
  s: State,
  user: string,
  projectId: string,
  subjectId: string,
  kind: CoordinationKind,
) {
  s.coordinationJobs ??= [];
  const p = member(s, user, projectId);
  const subject =
    kind === "assess"
      ? s.tasks.find((t) => t.id === subjectId && t.projectId === projectId)
      : kind === "decompose"
        ? s.stories.find((t) => t.id === subjectId && t.projectId === projectId)
        : subjectId === projectId
          ? p
          : undefined;
  if (!subject)
    throw new DomainError("forbidden", "协调对象必须属于当前项目", 403);
  const existing = s.coordinationJobs.find(
    (j) =>
      j.projectId === projectId &&
      j.subjectId === subjectId &&
      j.kind === kind &&
      !j.supersededBy &&
      j.status !== "completed",
  );
  if (existing) return existing;
  const j: CoordinationJob = {
    id: `coordination-${randomUUID()}`,
    projectId,
    subjectId,
    kind,
    status: "queued",
    requestedBy: user,
    input: coordinationContext(s, projectId, subjectId, kind),
    inputHash: coordinationInputHash(s, subjectId, kind),
    attemptHistory: [],
    agentId: p.coordinatorAgentId ?? null,
    epoch: p.coordinationEpoch ?? 0,
    attempts: 0,
    inputRevision:
      kind === "assess"
        ? (s.tasks.find((task) => task.id === subjectId)?.inputRevision ?? 1)
        : undefined,
    createdAt: iso(),
    updatedAt: iso(),
  };
  s.coordinationJobs.push(j);
  return j;
}
export function requestDecomposition(s: State, user: string, storyId: string) {
  const story = s.stories.find((t) => t.id === storyId);
  if (!story) throw new DomainError("not_found", "故事不存在", 404);
  member(s, user, story.projectId);
  if (story.published)
    throw new DomainError("conflict", "已发布故事不能重新拆解", 409);
  return enqueueCoordination(s, user, story.projectId, storyId, "decompose");
}
export function requestRetrospective(
  s: State,
  user: string,
  projectId: string,
) {
  owner(s, user, projectId);
  return enqueueCoordination(s, user, projectId, projectId, "retrospect");
}
export function retryCoordination(s: State, user: string, id: string) {
  const j = jobFor(s, user, id);
  if (j.status !== "failed")
    throw new DomainError("conflict", "只有失败协调工作可以重试", 409);
  if (j.recoveryRequired)
    throw new DomainError("recovery_required", "请先确认旧进程已停止", 409);
  if (outputCallCount(j) >= MAX_COORDINATION_OUTPUT_CALLS)
    throw new DomainError(
      "exhausted",
      "已达到 4 次输出调用上限，请 Owner 检查并调整需求",
      409,
    );
  if (j.attempts >= 3)
    throw new DomainError("exhausted", "已达到 3 次协调执行上限", 409);
  if (
    j.kind === "decompose" &&
    s.stories.find((x) => x.id === j.subjectId)?.published
  )
    throw new DomainError("conflict", "故事已经发布", 409);
  const p = s.projects.find((p) => p.id === j.projectId)!;
  j.status = "queued";
  j.agentId = p.coordinatorAgentId ?? null;
  j.epoch = p.coordinationEpoch ?? 0;
  j.error = undefined;
  j.updatedAt = iso();
  delete p.coordinationPaused;
  return j;
}
export function acknowledgeCoordinationStop(
  s: State,
  user: string,
  id: string,
) {
  const j = jobFor(s, user, id);
  if (j.status !== "failed" || !j.recoveryRequired)
    throw new DomainError("conflict", "当前无需确认停止", 409);
  j.recoveryRequired = false;
  j.updatedAt = iso();
  return j;
}
export function approveAssessment(s: State, user: string, id: string) {
  const t = taskFor(s, user, id);
  owner(s, user, t.projectId);
  if (!t.assessment || t.status !== "ready")
    throw new DomainError("conflict", "当前没有可确认的评估", 409);
  t.assessmentApproved = true;
  t.updatedAt = iso();
  return t;
}
export function coordinationWaitingReason(
  s: State,
  j: CoordinationJob,
  blockedAgents = new Set<string>(),
): string | undefined {
  if (j.status !== "queued") return undefined;
  const p = s.projects.find((p) => p.id === j.projectId)!;
  return coordinatorReadiness(s,p,blockedAgents).blockers[0]?.message ?? "等待协调执行";
}
export function reserveCoordination(
  s: State,
  now: number,
  stopping = new Set<string>(),
  stoppingOwners = new Set<string>(),
  blockedAgents = new Set<string>(),
) {
  const reserved: CoordinationJob[] = [];
  for (const j of s.coordinationJobs ?? []) {
    if (
      j.status !== "queued" ||
      j.supersededBy ||
      j.attempts >= 3 ||
      outputCallCount(j) >= MAX_COORDINATION_OUTPUT_CALLS ||
      stopping.has(j.id)
    )
      continue;
    const p = s.projects.find((p) => p.id === j.projectId)!;
    if (p.coordinationPaused) continue;
    const a = s.agents.find(
      (a) => a.id === p.coordinatorAgentId && a.ownerId === p.ownerId,
    );
    if (
      !a ||
      blockedAgents.has(a.id) ||
      !a.enabled ||
      !a.online ||
      !a.projectIds.includes(p.id) ||
      !isProjectMember(s, a.ownerId, p) ||
      !hasCapacity(s, a, stoppingOwners)
    )
      continue;
    if (
      j.kind === "decompose" &&
      s.stories.find((x) => x.id === j.subjectId)?.published
    ) {
      failed(j, "故事已发布，拆解已失效", now, false);
      continue;
    }
    j.agentId = a.id;
    j.epoch = p.coordinationEpoch ?? 0;
    j.status = "running";
    j.attempts++;
    j.fence = s.nextFence++;
    j.leaseUntil = now + 30000;
    j.updatedAt = iso(now);
    j.attemptHistory.push({
      id: `coord-attempt-${randomUUID()}`,
      agentId: a.id,
      ownerId: a.ownerId,
      deviceId: a.deviceId,
      epoch: j.epoch,
      fence: j.fence,
      startedAt: iso(now),
    });
    reserved.push(j);
  }
  return reserved;
}
export function validCoordination(
  s: State,
  j: CoordinationJob,
  fence: number,
  now: number,
) {
  const p = s.projects.find((p) => p.id === j.projectId);
  const a = s.agents.find((a) => a.id === j.agentId);
  return (
    j.status === "running" &&
    !j.supersededBy &&
    j.fence === fence &&
    (j.leaseUntil ?? 0) > now &&
    p?.coordinatorAgentId === j.agentId &&
    (p?.coordinationEpoch ?? 0) === j.epoch &&
    a?.ownerId === p?.ownerId &&
    a?.enabled &&
    a?.online &&
    a?.projectIds.includes(j.projectId) &&
    isProjectMember(s, a.ownerId, p)
  );
}
function leased(s: State, id: string, fence: number, now: number) {
  const j = s.coordinationJobs.find((j) => j.id === id);
  if (!j || !validCoordination(s, j, fence, now))
    throw new DomainError("stale_lease", "协调执行租约或配置已失效", 409);
  return j;
}
/** Persist before invoking the harness: interruption must not refund an uncertain call. */
export function beginCoordinationOutput(
  s: State,
  id: string,
  fence: number,
  now: number,
) {
  const j = leased(s, id, fence, now);
  assertCoordinationInput(s, j);
  // Old versions made one model call per workflow attempt. Count those conservatively,
  // excluding the newly reserved current attempt; never invent past output content.
  j.outputCalls ??= j.attemptHistory.slice(0, -1).map((attempt) => ({
    id: `legacy-output-${attempt.id}`,
    attemptId: attempt.id,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt,
    status: attempt.outcome === "completed" ? "valid" : "failed",
    nativeSession: attempt.nativeSession,
  }));
  if (j.outputCalls.length >= MAX_COORDINATION_OUTPUT_CALLS)
    throw new DomainError("exhausted", "已达到 4 次输出调用上限", 409);
  if (j.outputCalls.some((call) => call.status === "running"))
    throw new DomainError("conflict", "已有未结束的输出调用", 409);
  const call: CoordinationOutputCall = {
    id: `coord-output-${randomUUID()}`,
    correctionOf: j.outputCalls
      .slice()
      .reverse()
      .find((output) => output.status === "invalid")?.id,
    attemptId: j.attemptHistory.at(-1)!.id,
    startedAt: iso(now),
    status: "running",
  };
  j.outputCalls.push(call);
  j.updatedAt = iso(now);
  return call;
}
export function recordCoordinationOutput(
  s: State,
  id: string,
  fence: number,
  callId: string,
  result: Pick<
    CoordinationOutputCall,
    "output" | "truncated" | "issues" | "nativeSession"
  > & { status: "valid" | "invalid" },
  now: number,
) {
  const j = leased(s, id, fence, now);
  assertCoordinationInput(s, j);
  const call = j.outputCalls?.at(-1);
  if (
    call?.id !== callId ||
    call.status !== "running" ||
    call.attemptId !== j.attemptHistory.at(-1)!.id
  )
    throw new DomainError("stale_lease", "输出调用已失效", 409);
  Object.assign(call, result, { finishedAt: iso(now) });
  j.updatedAt = iso(now);
}
function assertCoordinationInput(s: State, j: CoordinationJob) {
  if (
    j.kind !== "retrospect" &&
    coordinationInputHash(s, j.subjectId, j.kind) !== j.inputHash
  )
    throw new DomainError("stale_lease", "协调输入快照已改变", 409);
}
export function heartbeatCoordination(
  s: State,
  id: string,
  fence: number,
  now: number,
) {
  leased(s, id, fence, now).leaseUntil = now + 30000;
}
export function failCoordination(
  s: State,
  id: string,
  fence: number,
  message: string,
  now: number,
  failureKind: "execution" | "output_invalid" = "execution",
) {
  const j = s.coordinationJobs.find((j) => j.id === id);
  if (!j || j.fence !== fence || j.status !== "running")
    throw new DomainError("stale_lease", "协调执行已失效", 409);
  failed(j, message, now);
  if (failureKind === "execution") pauseProject(s, j, message, now);
}
export function expireCoordination(s: State, now: number, all = false) {
  for (const j of s.coordinationJobs ?? [])
    if (
      j.status === "running" &&
      (all || !validCoordination(s, j, j.fence!, now))
    ) {
      const reason = all
        ? "服务重启：旧协调进程结果未知，请确认已停止"
        : "协调租约过期或授权已撤销，请确认旧进程停止";
      failed(j, reason, now);
      pauseProject(s, j, reason, now);
    }
}
export function completeCoordination(
  s: State,
  id: string,
  fence: number,
  raw: string,
  now: number,
) {
  const j = leased(s, id, fence, now);
  const result = parseCoordinationResult(j.kind, raw);
  if (
    j.kind !== "retrospect" &&
    coordinationInputHash(s, j.subjectId, j.kind) !== j.inputHash
  )
    throw new DomainError("stale_lease", "协调输入快照已改变", 409);
  if (j.kind === "assess") {
    const t = s.tasks.find(
      (t) => t.id === j.subjectId && t.projectId === j.projectId,
    );
    if (
      !t ||
      t.status !== "ready" ||
      t.title !== j.input.subject.title ||
      t.description.slice(0, 4000) !== j.input.subject.description ||
      t.acceptance.slice(0, 2000) !== j.input.subject.acceptance
    )
      throw new DomainError("stale_lease", "任务输入已改变", 409);
    t.assessment = result as Assessment;
    t.assessmentApproved = false;
    t.updatedAt = iso(now);
  }
  if (j.kind === "decompose") {
    const story = s.stories.find(
      (x) => x.id === j.subjectId && x.projectId === j.projectId,
    );
    if (
      !story ||
      story.published ||
      story.title !== j.input.subject.title ||
      story.description.slice(0, 4000) !== j.input.subject.description
    )
      throw new DomainError("stale_lease", "故事输入已改变或发布", 409);
  }
  j.result = result;
  j.status = "completed";
  j.error = undefined;
  j.recoveryRequired = false;
  j.updatedAt = iso(now);
  delete j.leaseUntil;
  Object.assign(j.attemptHistory.at(-1)!, {
    finishedAt: iso(now),
    outcome: "completed",
    summary: JSON.stringify(result),
  });
  return j;
}
