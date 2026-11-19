import type {
  Attempt,
  CodeChanges,
  RepositorySnapshot,
  State,
  Task,
} from "./contracts.ts";
import { DomainError, member } from "./workflow.ts";

export function requiresCodeWorkspace(s: State, task: Task) {
  return (
    !!s.projects.find((p) => p.id === task.projectId)?.repository &&
    (task.capability === "coding" ||
      task.assessment?.requiredCapability === "coding")
  );
}

export function repositoryBindingAllowed(
  s: State,
  user: string,
  projectId: string,
) {
  const project = member(s, user, projectId);
  if (project.ownerId !== user)
    throw new DomainError("forbidden", "仅 Owner 可以绑定代码仓库", 403);
  if (
    s.tasks.some(
      (t) =>
        t.projectId === projectId &&
        (t.attempts.length > 0 ||
          t.recoveryRequired ||
          ["assigned", "running"].includes(t.status)),
    ) ||
    s.coordinationJobs.some(
      (j) =>
        j.projectId === projectId &&
        (j.status === "running" || j.recoveryRequired),
    )
  )
    throw new DomainError(
      "conflict",
      "已有任务执行或协调工作未停止，仓库绑定只读",
      409,
    );
  return project;
}

export function bindRepository(
  s: State,
  user: string,
  projectId: string,
  snapshot: RepositorySnapshot,
) {
  const project = repositoryBindingAllowed(s, user, projectId);
  // Store metadata only: source path and store paths never belong to shared state.
  project.repository = {
    id: snapshot.id,
    commit: snapshot.commit,
    fileCount: snapshot.fileCount,
    createdAt: snapshot.createdAt,
  };
  return project.repository;
}

export function acceptedCodeDependencies(
  s: State,
  task: Task,
): { changes: CodeChanges[]; dependencyAttemptIds: string[] } {
  const snapshot = s.projects.find((p) => p.id === task.projectId)?.repository;
  if (!snapshot)
    throw new DomainError("code_context", "项目未绑定代码快照", 409);
  const changes: CodeChanges[] = [],
    dependencyAttemptIds: string[] = [];
  for (const dependency of acceptedDependencyTasks(s, task)) {
    const attempt = dependency.attempts.at(-1);
    if (requiresCodeWorkspace(s, dependency)) {
      if (
        !attempt?.codeChanges ||
        !attempt.codeContext ||
        attempt.codeChanges.repositorySnapshotId !== snapshot.id ||
        attempt.codeContext.repositorySnapshotId !== snapshot.id
      )
        throw new DomainError(
          "code_dependency",
          "已验收代码依赖缺少同快照的收集成果",
          409,
        );
      changes.push(attempt.codeChanges);
      dependencyAttemptIds.push(attempt.id);
    }
  }
  return { changes, dependencyAttemptIds };
}

export function acceptedDependencyTasks(s: State, task: Task) {
  const visited = new Set<string>(),
    visiting = new Set<string>(),
    ordered: Task[] = [];
  const visit = (id: string) => {
    if (visiting.has(id) || id === task.id)
      throw new DomainError("code_dependency", "代码依赖存在循环", 409);
    if (visited.has(id)) return;
    const dependency = s.tasks.find((t) => t.id === id);
    if (
      !dependency ||
      dependency.projectId !== task.projectId ||
      dependency.status !== "done"
    )
      throw new DomainError(
        "code_dependency",
        "代码依赖必须是同项目已验收任务",
        409,
      );
    visiting.add(id);
    for (const parent of [...dependency.dependsOn].sort()) visit(parent);
    visiting.delete(id);
    visited.add(id);
    ordered.push(dependency);
  };
  for (const id of [...task.dependsOn].sort()) visit(id);
  return ordered;
}

export function validateCodeContext(
  s: State,
  task: Task,
  context: NonNullable<Attempt["codeContext"]>,
) {
  const snapshot = s.projects.find((p) => p.id === task.projectId)?.repository;
  const dependencies = acceptedCodeDependencies(s, task);
  if (
    context.repositorySnapshotId !== snapshot?.id ||
    context.inputRevision !== (task.inputRevision ?? 1) ||
    JSON.stringify(context.dependencyAttemptIds) !==
      JSON.stringify(dependencies.dependencyAttemptIds)
  )
    throw new DomainError("code_context", "代码执行输入或依赖已变化", 409);
}
