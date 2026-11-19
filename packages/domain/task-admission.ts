import type { Agent, State, Task, TaskDispatch } from "./contracts.ts";
import { capacityBlocker, hasCapacity } from "./capacity.ts";
import { requiresCodeWorkspace } from "./code-execution.ts";
import { isProjectMember } from './access.ts';

const status = (
  ready: boolean,
  code: TaskDispatch["code"],
  message: string,
): TaskDispatch => ({ ready, code, message });

/** Read-only scheduling explanation. Candidate identities remain internal. */
export function taskAdmission(
  state: State,
  task: Task,
  blockedAgents = new Set<string>(),
  stoppingOwners = new Set<string>(),
): { status: TaskDispatch; candidates: Agent[] } | null {
  if (task.status !== "ready") return null;
  if (task.assessmentRequired && !task.assessment)
    return {
      status: status(false, "assessment", "等待项目协调 Agent 完成任务评估"),
      candidates: [],
    };
  if (
    task.assessmentRequired &&
    task.assessment &&
    (task.assessment.risk === "high" || task.assessment.confidence < 0.7) &&
    !task.assessmentApproved
  )
    return {
      status: status(
        false,
        "assessment_approval",
        "任务评估需要 Owner 确认后才能自动分配",
      ),
      candidates: [],
    };
  if (task.attempts.length >= task.maxAttempts)
    return {
      status: status(false, "attempt_budget", "任务已达到执行次数上限"),
      candidates: [],
    };
  if (
    !task.dependsOn.every((dependency) =>
      state.tasks.some(
        (candidate) =>
          candidate.id === dependency && candidate.status === "done",
      ),
    )
  )
    return {
      status: status(false, "dependencies", "等待依赖任务验收完成"),
      candidates: [],
    };

  const project = state.projects.find(
    (candidate) => candidate.id === task.projectId,
  )!;
  let candidates = state.agents.filter(
    (agent) =>
      agent.projectIds.includes(project.id) &&
      isProjectMember(state, agent.ownerId, project),
  );
  if (!candidates.length)
    return {
      status: status(
        false,
        "no_granted_agent",
        "项目尚无获得执行授权的 Agent",
      ),
      candidates,
    };

  candidates = candidates.filter(
    (agent) =>
      (agent.provider !== "dsh" ||
        (task.capability === "writing" &&
          (task.assessment?.requiredCapability ?? "writing") === "writing")) &&
      (!requiresCodeWorkspace(state, task) || agent.provider !== "demo"),
  );
  if (!candidates.length)
    return {
      status: status(
        false,
        "capability",
        "已授权 Agent 不支持任务所需执行能力",
      ),
      candidates,
    };

  candidates = candidates.filter(
    (agent) =>
      !task.assessment ||
      (task.assessment.difficulty >= (agent.difficultyRange?.min ?? 1) &&
        task.assessment.difficulty <= (agent.difficultyRange?.max ?? 5)),
  );
  if (!candidates.length)
    return {
      status: status(
        false,
        "difficulty",
        "任务难度不在已授权 Agent 的接单范围内",
      ),
      candidates,
    };

  candidates = candidates.filter((agent) => agent.enabled);
  if (!candidates.length)
    return {
      status: status(false, "disabled", "可执行此任务的 Agent 尚未启用"),
      candidates,
    };

  candidates = candidates.filter((agent) => agent.online);
  if (!candidates.length)
    return {
      status: status(false, "offline", "可执行此任务的 Agent 当前不在线"),
      candidates,
    };

  candidates = candidates.filter((agent) => !blockedAgents.has(agent.id));
  if (!candidates.length)
    return {
      status: status(
        false,
        "not_accepting",
        "本机执行器暂不接收新工作，请检查账号连接或停止状态",
      ),
      candidates,
    };

  candidates = candidates.filter(
    (agent) =>
      capacityBlocker(state, agent, stoppingOwners) !== "recovery_required",
  );
  if (!candidates.length)
    return {
      status: status(
        false,
        "recovery",
        "旧执行尚未确认停止，等待解除资源隔离",
      ),
      candidates,
    };

  const inFlight = state.tasks.filter(
    (candidate) =>
      candidate.status === "assigned" || candidate.status === "running",
  );
  candidates = candidates.filter(
    (agent) =>
      hasCapacity(state, agent, stoppingOwners) &&
      inFlight.filter((candidate) => candidate.agentId === agent.id).length <
        agent.maxConcurrency &&
      inFlight.filter(
        (candidate) => candidate.responsibleUserId === agent.ownerId,
      ).length <
        (state.users.find((user) => user.id === agent.ownerId)?.maxConcurrency ??
          0),
  );
  if (!candidates.length)
    return {
      status: status(false, "capacity", "执行并发已满，等待当前工作结束"),
      candidates,
    };

  return {
    status: status(true, "eligible", "已有执行资源满足自动分配条件"),
    candidates,
  };
}
