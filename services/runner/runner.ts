import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type pg from "pg";
import type {
  Agent,
  Executor,
  Task,
  State,
} from "../../packages/domain/contracts.ts";
import {
  expire,
  schedule,
  start,
  report,
  heartbeat,
  fail,
  DomainError,
} from "../../packages/domain/workflow.ts";
import { Repository } from "../control-plane/repository.ts";
import { normalizeResult, redactText } from "./results.ts";
import {
  expireCoordination,
  reserveCoordination,
  validCoordination,
  heartbeatCoordination,
} from "../../packages/domain/coordination.ts";
import { executeCoordination } from "./coordination.ts";
import { SnapshotStore, type PreparedWorkspace } from "./snapshots.ts";
import {
  acceptedCodeDependencies,
  requiresCodeWorkspace,
  validateCodeContext,
} from "../../packages/domain/code-execution.ts";
import { writingDependencyContext } from "./dependency-context.ts";
import { ExecutorStopUnconfirmed } from '../../packages/domain/execution-errors.ts';
import { isProjectMember } from '../../packages/domain/access.ts';

function authorizedTask(s: State, taskId: string, fence: number) {
  const task = s.tasks.find((t) => t.id === taskId);
  if (
    !task ||
    task.fence !== fence ||
    !["assigned", "running"].includes(task.status) ||
    (task.leaseUntil ?? 0) <= Date.now()
  )
    throw new DomainError("stale_lease", "执行租约已失效，拒绝旧结果", 409);
  const agent = s.agents.find((a) => a.id === task.agentId),
    project = s.projects.find((p) => p.id === task.projectId),
    attempt = task.attempts.at(-1);
  if (
    !agent?.enabled ||
    !agent.online ||
    !agent.projectIds.includes(task.projectId) ||
    !isProjectMember(s, agent.ownerId, project) ||
    agent.ownerId !== task.responsibleUserId ||
    attempt?.agentId !== agent.id ||
    attempt.ownerId !== agent.ownerId ||
    attempt.fence !== fence ||
    (agent.provider === 'dsh' && (task.capability !== 'writing' || (task.assessment?.requiredCapability ?? 'writing') !== 'writing')) ||
    (requiresCodeWorkspace(s, task) && agent.provider === "demo")
  )
    throw new DomainError(
      "forbidden",
      "执行授权已撤销，已请求停止本机进程",
      403,
    );
  return task;
}

type Job = {
  provider: Agent["provider"];
  fence: number;
  ownerId: string;
  controller: AbortController;
  promise: Promise<void>;
  heartbeatAt: number;
};
export class Runner {
  private jobs = new Map<string, Job>();
  private timer?: NodeJS.Timeout;
  private ticking?: Promise<void>;
  private leader?: pg.PoolClient;
  private stopped = true;
  private stopPromise?: Promise<void>;
  constructor(
    private repo: Repository,
    private executors: Partial<Record<Agent['provider'], Executor>>,
    private directory = resolve(".runtime/workspaces"),
    private snapshots?: SnapshotStore,
    private accounts?: {
      available: (agent: Agent) => boolean;
      accepting: (agent: Agent) => boolean;
    },
  ) {}
  get running() {
    return this.jobs.size;
  }
  async start() {
    this.leader = await this.repo.lockRunner();
    this.leader.on("error", () => {
      console.error("[runner] leader connection lost; stopping all local jobs");
      void this.stop();
    });
    try {
      await this.repo.mutate((s) => {
        expire(s, Date.now(), true);
        expireCoordination(s, Date.now(), true);
        for (const a of s.agents.filter(a=>!a.executionMode))
          a.online =
            !!this.executors[a.provider] &&
            (this.accounts?.available(a) ?? true);
      });
      this.stopped = false;
      this.timer = setInterval(() => this.kick(), 200);
      this.kick();
    } catch (error) {
      this.leader.release(true);
      this.leader = undefined;
      throw error;
    }
  }
  private kick() {
    if (this.stopped || this.ticking) return;
    this.ticking = this.tick()
      .catch(() => {
        console.error(
          "[runner] scheduling/heartbeat unavailable; interrupting local jobs",
        );
        for (const job of this.jobs.values()) job.controller.abort();
      })
      .finally(() => {
        this.ticking = undefined;
      });
  }
  private async tick() {
    const now = Date.now();
    const assigned = await this.repo.mutate((s) => {
      for(const a of s.agents.filter(a=>a.executionMode))a.online=(a.remoteReadyUntil??0)>now;
      if (this.accounts)
        for (const a of s.agents.filter(a=>!a.executionMode))
          a.online = !!this.executors[a.provider] && this.accounts.available(a);
      expire(s, now);
      expireCoordination(s, now);
      const stoppingOwners = new Set<string>();
      for (const [taskId, job] of this.jobs) {
        const coordination = s.coordinationJobs.find((j) => j.id === taskId);
        if (coordination) {
          if (
            !validCoordination(s, coordination, job.fence, now) ||
            job.controller.signal.aborted
          ) {
            job.controller.abort();
            stoppingOwners.add(job.ownerId);
          } else if (now - job.heartbeatAt > 5000) {
            heartbeatCoordination(s, taskId, job.fence, now);
            job.heartbeatAt = now;
          }
          continue;
        }
        const task = s.tasks.find((t) => t.id === taskId);
        const valid =
          task &&
          task.fence === job.fence &&
          (task.status === "running" || task.status === "assigned");
        let authorized = false;
        try { authorizedTask(s, taskId, job.fence); authorized = true; } catch { /* Stop below; never renew a revoked lease. */ }
        if (!valid || !authorized) {
          job.controller.abort();
          stoppingOwners.add(job.ownerId);
          if (valid)
            fail(
              s,
              taskId,
              job.fence,
              "执行授权已撤销，已请求停止本机进程",
              now,
            );
        } else if (
          !job.controller.signal.aborted &&
          now - job.heartbeatAt > 5000
        ) {
          heartbeat(s, taskId, job.fence, now);
          job.heartbeatAt = now;
        }
        if (job.controller.signal.aborted) stoppingOwners.add(job.ownerId);
      }
      const stopping = new Set(this.jobs.keys());
      const blockedAgents = new Set(
        s.agents
          .filter((a) => this.accounts && !this.accounts.accepting(a))
          .map((a) => a.id),
      );
      const coordination = reserveCoordination(
        s,
        now,
        stopping,
        stoppingOwners,
        blockedAgents,
      );
      return {
        coordination,
        tasks: schedule(s, now, stopping, stoppingOwners, blockedAgents),
      };
    });
    for (const coordination of assigned.coordination) {
      if (this.stopped) break;
      const controller = new AbortController();
      const state = await this.repo.read();
      const job: Job = {
        provider: state.agents.find((a) => a.id === coordination.agentId)!
          .provider,
        fence: coordination.fence!,
        ownerId: state.agents.find((a) => a.id === coordination.agentId)!
          .ownerId,
        controller,
        promise: Promise.resolve(),
        heartbeatAt: now,
      };
      this.jobs.set(coordination.id, job);
      job.promise = executeCoordination(
        this.repo,
        coordination,
        this.executors,
        this.directory,
        controller.signal,
      ).finally(() => this.jobs.delete(coordination.id));
    }
    for (const task of assigned.tasks) {
      if (this.stopped) break;
      const controller = new AbortController();
      const job: Job = {
        provider: (await this.repo.read()).agents.find(
          (a) => a.id === task.agentId,
        )!.provider,
        fence: task.fence!,
        ownerId: task.responsibleUserId!,
        controller,
        promise: Promise.resolve(),
        heartbeatAt: now,
      };
      this.jobs.set(task.id, job);
      job.promise = this.execute(task, controller.signal).finally(() =>
        this.jobs.delete(task.id),
      );
    }
  }
  /** Caller closes admission first. Include reservations still preparing behind tick. */
  async drainProvider(provider: Agent["provider"]) {
    await this.ticking;
    await Promise.all(
      [...this.jobs.values()]
        .filter((j) => j.provider === provider)
        .map((j) => j.promise),
    );
    const state = await this.repo.read();
    const ids = new Set(
      state.agents.filter((a) => a.provider === provider).map((a) => a.id),
    );
    if (
      state.tasks.some(
        (t) =>
          ids.has(t.agentId ?? "") &&
          (t.recoveryRequired || ["assigned", "running"].includes(t.status)),
      ) ||
      state.coordinationJobs.some(
        (j) =>
          ids.has(j.agentId ?? "") &&
          (j.recoveryRequired || j.status === "running"),
      )
    )
      throw new DomainError(
        "account_drain_blocked",
        "旧执行尚未确认停止，暂时不能切换账号",
        409,
      );
  }
  private async execute(task: Task, signal: AbortSignal) {
    const fence = task.fence!;
    let stopConfirmed = true;
    let localDirectory = "";
    try {
      const state = await this.repo.read();
      task = authorizedTask(state, task.id, fence);
      const agent = state.agents.find((a) => a.id === task.agentId)!;
      const executor = this.executors[agent.provider];
      if (!executor) throw new Error("执行器不可用");
      const attempt = task.attempts.at(-1)!;
      let prepared: PreparedWorkspace | undefined;
      let dependencies: ReturnType<typeof acceptedCodeDependencies> | undefined;
      if (requiresCodeWorkspace(state, task)) {
        if (!this.snapshots)
          throw new Error("本地快照存储未配置，无法执行代码任务");
        dependencies = acceptedCodeDependencies(state, task);
        prepared = await this.snapshots.prepare(
          state.projects.find((p) => p.id === task.projectId)!.repository!,
          dependencies.changes,
          attempt.id,
          signal,
        );
      }
      const cwd = prepared?.cwd ?? resolve(this.directory, attempt.id);
      localDirectory = cwd;
      if (!prepared) await mkdir(cwd, { recursive: true });
      signal.throwIfAborted();
      await this.repo.mutate((s) => {
        signal.throwIfAborted();
        const current = authorizedTask(s, task.id, fence);
        if (prepared && dependencies) {
          const context = {
            repositorySnapshotId: prepared.repositorySnapshotId,
            inputSnapshotId: prepared.inputSnapshotId,
            inputRevision: task.inputRevision ?? 1,
            dependencyAttemptIds: dependencies.dependencyAttemptIds,
          };
          validateCodeContext(s, current, context);
          current.attempts.at(-1)!.codeContext = context;
        }
        start(s, task.id, fence, Date.now());
      });
      const timeout = AbortSignal.timeout(15 * 60 * 1000);
      const executionSignal = AbortSignal.any([signal, timeout]);
      const result = await executor.run(
        {
          taskId: task.id,
          attemptId: attempt.id,
          fence,
          title: task.title,
          description:
            task.description +
            (prepared ? writingDependencyContext(state, task) : ""),
          acceptance: task.acceptance,
          feedback: task.feedback,
          cwd,
        },
        executionSignal,
      );
      executionSignal.throwIfAborted();
      // Executor.run resolves only after it and every child have stopped. Collection
      // is never concurrent with an executor writer; cancellation/fence checks repeat.
      authorizedTask(await this.repo.read(), task.id, fence);
      const collected = prepared
        ? await this.snapshots!.collect(prepared, executionSignal)
        : undefined;
      const normalized = normalizeResult(result); // strips executor-supplied change metadata
      const hidePath = (value: string) =>
        value.split(cwd).join("[local workspace]");
      normalized.summary = hidePath(normalized.summary);
      normalized.artifacts = normalized.artifacts.map((a) => ({
        name: a.name,
        content: hidePath(a.content),
      }));
      if (collected) {
        normalized.artifacts = [
          ...normalized.artifacts
            .filter((a) => a.name !== "code-changes.txt")
            .slice(0, 7),
          ...collected.artifacts,
        ];
        normalized.checksPassed = false;
      }
      await this.repo.mutate((s) => {
        executionSignal.throwIfAborted();
        authorizedTask(s, task.id, fence);
        report(s, task.id, fence, normalized, Date.now(), collected?.changes);
      });
    } catch (error) {
      if (error instanceof ExecutorStopUnconfirmed) stopConfirmed = false;
      if (error instanceof DomainError && error.code === "stale_lease") return;
      const message = signal.aborted
        ? "执行已中断，请确认状态后重试"
        : error instanceof Error
          ? redactText(
              localDirectory
                ? error.message.split(localDirectory).join("[local workspace]")
                : error.message,
            ).slice(0, 500)
          : "执行器异常";
      try {
        await this.repo.mutate((s) =>
          fail(s, task.id, fence, message, Date.now()),
        );
      } catch {
        console.error(
          "[runner] result rejected or database unavailable; task requires lease recovery",
        );
      }
    } finally {
      // The executor contract resolves only after child teardown; this is local stop evidence.
      await this.repo
        .mutate((s) => {
          const t = s.tasks.find((t) => t.id === task.id);
          if (stopConfirmed && t?.fence === fence && t.recoveryRequired)
            t.recoveryRequired = false;
        })
        .catch(() => {});
    }
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.stopPromise = (async () => {
      await this.ticking;
      for (const job of this.jobs.values()) job.controller.abort();
      await Promise.allSettled([...this.jobs.values()].map((j) => j.promise));
      if (this.leader) {
        await this.leader
          .query("SELECT pg_advisory_unlock(hashtext($1))", [
            `mas-runner:${this.repo.key}`,
          ])
          .catch(() => {});
        this.leader.release(true);
        this.leader = undefined;
      }
    })();
    return this.stopPromise;
  }
}
