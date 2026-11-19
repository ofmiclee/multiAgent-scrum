import { randomUUID } from "node:crypto";
import type { CoordinationJob, State, Task } from "./contracts.ts";
import {
  coordinationContext,
  coordinationInputHash,
} from "./coordination-results.ts";
import { DomainError, member, taskFor } from "./workflow.ts";

export type ReviseTaskAssessmentInput = {
  title: string;
  description: string;
  acceptance: string;
  capability: "coding" | "writing";
  reason: string;
  expectedRevision: number;
  failedJobId: string;
};

function boundedText(
  value: unknown,
  label: string,
  max: number,
  allowEmpty = false,
) {
  if (typeof value !== "string" || value.length > max)
    throw new DomainError("invalid", `${label}格式无效或超过长度限制`);
  const trimmed = value.trim();
  if (!allowEmpty && !trimmed)
    throw new DomainError("invalid", `${label}不能为空`);
  return trimmed;
}

function currentAssessmentJob(s: State, task: Task) {
  return s.coordinationJobs
    .filter(
      (job) =>
        job.projectId === task.projectId &&
        job.subjectId === task.id &&
        job.kind === "assess" &&
        !job.supersededBy,
    )
    .at(-1);
}

export function reviseTaskAssessment(
  s: State,
  user: string,
  taskId: string,
  input: ReviseTaskAssessmentInput,
): { task: Task; job: CoordinationJob } {
  const task = taskFor(s, user, taskId);
  const project = member(s, user, task.projectId);
  if (project.ownerId !== user)
    throw new DomainError(
      "forbidden",
      "仅项目 Owner 可调整需求并重新评估",
      403,
    );

  const title = boundedText(input.title, "任务标题", 200);
  const description = boundedText(input.description, "任务描述", 20000, true);
  const acceptance = boundedText(input.acceptance, "验收标准", 20000);
  const reason = boundedText(input.reason, "调整原因", 500);
  if (input.capability !== "coding" && input.capability !== "writing")
    throw new DomainError("invalid", "任务能力无效");
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1)
    throw new DomainError("invalid", "输入版本无效");
  if (typeof input.failedJobId !== "string" || !input.failedJobId)
    throw new DomainError("invalid", "失败评估标识无效");

  const revision = task.inputRevision ?? 1;
  if (input.expectedRevision !== revision)
    throw new DomainError("stale_revision", "任务输入版本已改变", 409);
  if (
    task.status !== "ready" ||
    task.attempts.length > 0 ||
    task.result !== null ||
    task.recoveryRequired
  )
    throw new DomainError("conflict", "只有尚未执行的待领取任务可以调整", 409);

  const failed = currentAssessmentJob(s, task);
  if (!failed || failed.id !== input.failedJobId)
    throw new DomainError("stale_revision", "失败评估已不是当前版本", 409);
  if (
    failed.status !== "failed" ||
    failed.recoveryRequired ||
    failed.outputCalls?.some((call) => call.status === "running") ||
    (failed.outputCalls?.length ?? failed.attemptHistory.length) < 4
  )
    throw new DomainError(
      "conflict",
      "当前评估尚未停止并用尽输出机会，不能重新评估",
      409,
    );

  const nextInput = {
    title,
    description,
    acceptance,
    capability: input.capability,
  };
  const previousInput = {
    title: task.title,
    description: task.description,
    acceptance: task.acceptance,
    capability: task.capability,
  };
  if (
    previousInput.title.trim() === nextInput.title &&
    previousInput.description.trim() === nextInput.description &&
    previousInput.acceptance.trim() === nextInput.acceptance &&
    previousInput.capability === nextInput.capability
  )
    throw new DomainError("unchanged", "请至少修改一项任务输入", 409);

  const nextRevision = revision + 1;
  const now = new Date().toISOString();
  const jobId = `coordination-${randomUUID()}`;
  const nextTask = { ...task, ...nextInput, inputRevision: nextRevision };
  const nextState = {
    ...s,
    tasks: s.tasks.map((item) => (item.id === task.id ? nextTask : item)),
  };
  const job: CoordinationJob = {
    id: jobId,
    projectId: task.projectId,
    subjectId: task.id,
    kind: "assess",
    status: "queued",
    requestedBy: user,
    input: coordinationContext(nextState, task.projectId, task.id, "assess"),
    inputHash: coordinationInputHash(nextState, task.id, "assess"),
    attemptHistory: [],
    agentId: project.coordinatorAgentId ?? null,
    epoch: project.coordinationEpoch ?? 0,
    attempts: 0,
    supersedes: failed.id,
    inputRevision: nextRevision,
    createdAt: now,
    updatedAt: now,
  };

  Object.assign(task, nextInput, {
    inputRevision: nextRevision,
    updatedAt: now,
  });
  delete task.assessment;
  delete task.assessmentApproved;
  failed.supersededBy = job.id;
  task.inputHistory ??= [];
  task.inputHistory.push({
    revision,
    input: previousInput,
    reason,
    actorId: user,
    failedAssessmentJobId: failed.id,
    replacementAssessmentJobId: job.id,
    revisedAt: now,
  });
  s.coordinationJobs.push(job);
  return { task, job };
}
