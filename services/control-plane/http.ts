import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { authorizeCommand } from './command-access.ts';
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { z } from "zod";
import { Repository } from "./repository.ts";
import * as workflow from "../../packages/domain/workflow.ts";
import * as coordination from "../../packages/domain/coordination.ts";
import { reviseTaskAssessment } from "../../packages/domain/task-revisions.ts";
import type {
  RepositorySnapshot,
  State,
  Workspace,
} from "../../packages/domain/contracts.ts";
import {
  bindRepository,
  repositoryBindingAllowed,
} from "../../packages/domain/code-execution.ts";
import type { SnapshotStore } from "../runner/snapshots.ts";
import type { CodexConnection } from "../runner/codex-connection.ts";
import type { DshConnection } from '../runner/dsh-connection.ts';
import type { RunnerDevices } from './runner-devices.ts';
import { runnerDeviceHttp } from './runner-device-http.ts';
import type {RunnerTasks} from './runner-tasks.ts';

const short = z.string().trim().min(1).max(200);
const long = z.string().max(20000);
const draft = z
  .object({
    title: short,
    description: long,
    acceptance: long.trim().min(1),
    capability: z.enum(["coding", "writing"]),
    priority: z.number().int().min(1).max(3),
    dependsOnIndexes: z.array(z.number().int().min(0)).max(50),
    reviewPolicy: z.enum(["human", "automatic"]).default("human"),
  })
  .strict();
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new workflow.DomainError("invalid", "需要 JSON 请求", 415);
  const parts: Buffer[] = [];
  let bytes = 0;
  for await (const part of req) {
    bytes += part.length;
    if (bytes > 256000)
      throw new workflow.DomainError("too_large", "请求超过本地预览限制", 413);
    parts.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw new workflow.DomainError("invalid", "JSON 格式无效");
  }
}

/** This is intentionally a loopback-only preview identity adapter. Never deploy it behind a public proxy. */
export function createApp(
  repo: Repository,
  runtime: () => Workspace["runtime"],
  uiDirectory = resolve("dist/ui"),
  snapshots?: SnapshotStore,
  accounts?: { connection: CodexConnection; drain: () => Promise<void> },
  dshAccounts?: { connection: DshConnection; drain: () => Promise<void> },
  devices?: RunnerDevices,
  remoteTasks?: RunnerTasks,
) {
  const accountCommands = new Map<
    string,
    { path: string; promise: Promise<unknown> }
  >();
  const sessions = new Map<string, { user: string; expires: number }>();
  const imports = new Map<
    string,
    { hash: string; promise: Promise<RepositorySnapshot> }
  >();
  const cookieName = `mas_session_${createHash("sha256").update(repo.key).digest("hex").slice(0, 24)}`;
  return createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const port = req.socket.localPort;
      const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      if (
        !hosts.has(req.headers.host ?? "") ||
        req.headers["sec-fetch-site"] === "cross-site"
      )
        throw new workflow.DomainError("forbidden", "拒绝非本地来源请求", 403);
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const path = url.pathname;
      if (path.startsWith('/api/runner/')) {
        if (!devices) throw new workflow.DomainError('unavailable', '独立 Runner 连接未启用', 503);
        await runnerDeviceHttp(req, res, path, devices, remoteTasks);
        return;
      }
      if (req.method === "GET" && path === "/api/health") {
        await repo.read();
        json(res, 200, {
          ok: true,
          mode: "local-preview",
          database: "connected",
        });
        return;
      }
      if (!path.startsWith("/api/")) {
        if (req.method !== "GET" && req.method !== "HEAD")
          throw new workflow.DomainError("not_found", "未找到页面", 404);
        const file = resolve(
          uiDirectory,
          "." + decodeURIComponent(path === "/" ? "/index.html" : path),
        );
        if (!file.startsWith(uiDirectory + sep))
          throw new workflow.DomainError("forbidden", "无效路径", 403);
        let contents: Buffer;
        try {
          contents = await readFile(file);
        } catch {
          throw new workflow.DomainError(
            "not_found",
            "页面尚未构建，请先运行 npm run build",
            404,
          );
        }
        const mime: Record<string, string> = {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".svg": "image/svg+xml",
          ".png": "image/png",
        };
        res.writeHead(200, {
          "Content-Type": mime[extname(file)] ?? "application/octet-stream",
        });
        res.end(req.method === "HEAD" ? undefined : contents);
        return;
      }
      // Vite proxy retains the frontend Origin during local development.
      const origins = new Set([
        `http://127.0.0.1:${port}`,
        `http://localhost:${port}`,
        "http://127.0.0.1:4318",
        "http://localhost:4318",
      ]);
      if (req.method !== "GET" && !origins.has(req.headers.origin ?? ""))
        throw new workflow.DomainError("forbidden", "请求来源校验失败", 403);
      const token = new RegExp(
        `(?:^|;\\s*)${cookieName}=([a-f0-9]{48})(?:;|$)`,
      ).exec(req.headers.cookie ?? "")?.[1];
      let session = token ? sessions.get(token) : undefined;
      if (session && session.expires < Date.now()) {
        sessions.delete(token!);
        session = undefined;
      }
      if (!session && req.method === "GET" && path === "/api/workspace") {
        for (const [key, value] of sessions)
          if (value.expires < Date.now()) sessions.delete(key);
        if (sessions.size >= 1000)
          throw new workflow.DomainError(
            "preview_limit",
            "本地会话数量已满",
            429,
          );
        const next = randomBytes(24).toString("hex");
        session = { user: "owner", expires: Date.now() + 86400000 };
        sessions.set(next, session);
        res.setHeader(
          "Set-Cookie",
          `${cookieName}=${next}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
        );
      }
      if (!session)
        throw new workflow.DomainError(
          "unauthorized",
          "请先打开本地看板建立预览会话",
          401,
        );
      const user = session.user;
      if (req.method === 'GET' && path === '/api/runners') {
        json(res, 200, {enabled:!!devices, devices:devices ? await devices.list(user) : []});
        return;
      }
      const dshRoute = path === '/api/dsh/account' || path.startsWith('/api/dsh/account/');
      const selectedAccounts = dshRoute ? dshAccounts : accounts;
      const accountPath = dshRoute ? '/api/dsh/account' : '/api/codex/account';
      if (
        path === accountPath || path.startsWith(accountPath + '/')
      ) {
        if (!selectedAccounts)
          throw new workflow.DomainError(
            "unavailable",
            "账号接入未启用，请由本机用户启用对应 Runtime",
            503,
          );
        if (user !== selectedAccounts.connection.owner)
          throw new workflow.DomainError(
            "forbidden",
            "当前身份不能操作此本机账号",
            403,
          );
        if (req.method === "GET" && path === accountPath) {
          json(res, 200, selectedAccounts.connection.view());
          return;
        }
      }
      if (req.method === "GET" && path === "/api/workspace") {
        const state = await repo.read();
        // Admission is device-local and can close before the next persisted presence tick.
        // Share only a generic scheduling blocker, never account identity or credentials.
        const blockedAgents = new Set(state.agents.filter(a => {
          if(a.executionMode)return false;
          const manager = a.provider === 'codex' ? accounts : a.provider === 'dsh' ? dshAccounts : undefined;
          return manager && !manager.connection.accepting(a.ownerId);
        }).map(a => a.id));
        const visible = workflow.workspaceFor(state, user, blockedAgents);
        const ownCodex = visible.agents.some(
          (a) => a.ownerId === user && a.provider === "codex",
        );
        const local = runtime();
        json(res, 200, {
          ...visible,
          runtime: {
            codexAvailable: ownCodex && local.codexAvailable,
            ...(user === dshAccounts?.connection.owner ? {dshAvailable:true} : {}),
            codexVersion: ownCodex ? local.codexVersion : null,
            running:
              visible.tasks.filter((t) => t.status === "running").length +
              visible.coordinationJobs.filter((j) => j.status === "running")
                .length,
          },
        });
        return;
      }
      const artifact = /^\/api\/tasks\/([^/]+)\/artifacts\/(\d+)$/.exec(path);
      if (req.method === "GET" && artifact) {
        const t = workflow.taskFor(await repo.read(), user, artifact[1]);
        const item = t.result?.artifacts[Number(artifact[2])];
        if (!item)
          throw new workflow.DomainError("not_found", "成果不存在", 404);
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="artifact.txt"; filename*=UTF-8''${encodeURIComponent(item.name)}`,
        });
        res.end(item.content);
        return;
      }
      if (req.method !== "POST")
        throw new workflow.DomainError("not_found", "接口不存在", 404);
      const data = await body(req);
      const key = z
        .string()
        .min(8)
        .max(100)
        .regex(/^[a-zA-Z0-9_-]+$/)
        .parse(req.headers["idempotency-key"]);
      if (path === '/api/runners/bind' || path === '/api/runners/revoke') {
        if (!devices) throw new workflow.DomainError('unavailable', '独立 Runner 连接未启用', 503);
        const result = path.endsWith('/bind')
          ? await devices.bind(user, z.object({code:z.string().regex(/^[A-F0-9]{16}$/)}).strict().parse(data).code)
          : await devices.revoke(user, z.object({runnerId:z.string().uuid()}).strict().parse(data).runnerId);
        json(res, 200, result);
        return;
      }
      if (path.startsWith(accountPath + '/') && selectedAccounts) {
        z.object({}).strict().parse(data);
        const action = path.slice(accountPath.length + 1);
        if (!(dshRoute ? ['detect','local','disconnect'] : ["detect", "local", "login", "disconnect"]).includes(action))
          throw new workflow.DomainError("not_found", "账号接口不存在", 404);
        const prior = accountCommands.get(key);
        if (prior && prior.path !== path)
          throw new workflow.DomainError(
            "idempotency_conflict",
            "幂等键对应的请求不同",
            409,
          );
        if (prior) {
          await prior.promise;
          json(res, 200, selectedAccounts.connection.view());
          return;
        }
        if (accountCommands.size >= 1000)
          throw new workflow.DomainError(
            "preview_limit",
            "本地账号操作次数已达预览限制",
            409,
          );
        const c = selectedAccounts.connection;
        const promise = (
          action === "detect"
            ? c.detect()
            : action === "local"
              ? c.connectLocal()
              : action === "login" && 'beginLogin' in c
                ? c.beginLogin()
                : c.disconnect(selectedAccounts.drain)
        ).catch((error) => {
          if (error instanceof workflow.DomainError) throw error;
          // The operation has settled and the manager retains its safe state.
          // A definitive rejection releases the UI intent key for an explicit retry;
          // transport failures still retain the original key and cannot duplicate work.
          throw new workflow.DomainError(
            "account_operation_failed",
            action === "disconnect"
              ? "退出未完成，请检查运行状态后重试退出连接"
              : "无法完成账号操作，请检查对应 Runtime 后重试",
            409,
          );
        });
        accountCommands.set(key, { path, promise });
        await promise;
        json(res, 200, c.view());
        return;
      }
      if (path === "/api/session") {
        const { userId } = z.object({ userId: short }).strict().parse(data);
        if (!(await repo.read()).users.some((u) => u.id === userId))
          throw new workflow.DomainError("forbidden", "未知测试身份", 403);
        session.user = userId;
        json(res, 200, { ok: true });
        return;
      }
      let command: ((s: State) => unknown) | undefined;
      const repositoryRoute = /^\/api\/projects\/([^/]+)\/repository$/.exec(
        path,
      );
      if (repositoryRoute) {
        const d = z
          .object({ path: z.string().min(1).max(4096), ref: short })
          .strict()
          .parse(data);
        const projectId = repositoryRoute[1];
        const hash = createHash("sha256")
          .update(path + "\n" + JSON.stringify(d))
          .digest("hex");
        const commandKey = `${user}:${key}`;
        const pending = imports.get(commandKey);
        if (pending) {
          if (pending.hash !== hash)
            throw new workflow.DomainError(
              "idempotency_conflict",
              "幂等键对应的请求内容不同",
              409,
            );
          const result = await pending.promise;
          workflow.member(await repo.read(), user, projectId);
          json(res, 200, result);
          return;
        }
        const importing = (async () => {
          const state = await repo.read();
          // Replay before import or eligibility checks: a committed binding remains
          // replayable even after execution starts or the original source disappears.
          const previous = state.commands[`${user}:${key}`];
          workflow.member(state, user, projectId);
          if (previous) {
            if (previous.hash !== hash)
              throw new workflow.DomainError(
                "idempotency_conflict",
                "幂等键对应的请求内容不同",
                409,
              );
            return previous.result as RepositorySnapshot;
          }
          repositoryBindingAllowed(state, user, projectId);
          if (!snapshots)
            throw new workflow.DomainError(
              "unavailable",
              "本地快照存储未配置",
              503,
            );
          const controller = new AbortController();
          const disconnect = () => {
            if (!res.writableFinished) controller.abort();
          };
          res.on("close", disconnect);
          try {
            const signal = AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(120000),
            ]);
            let snapshot;
            try {
              snapshot = await snapshots.importGit(d.path, d.ref, signal);
            } catch {
              throw new workflow.DomainError(
                "repository_import",
                "仓库导入失败：请检查路径、提交引用、文件类型与敏感文件限制",
                400,
              );
            }
            signal.throwIfAborted();
            const result = await repo.command(user, key, hash, (s) => {
              signal.throwIfAborted();
              return bindRepository(s, user, projectId, snapshot);
            }, (s) => { workflow.member(s, user, projectId); });
            return result;
          } finally {
            res.off("close", disconnect);
          }
        })();
        imports.set(commandKey, { hash, promise: importing });
        try {
          const result = await importing;
          workflow.member(await repo.read(), user, projectId);
          json(res, 200, result);
          return;
        } finally {
          imports.delete(commandKey);
        }
      }
      const coordinatorRoute = /^\/api\/projects\/([^/]+)\/coordinator$/.exec(
        path,
      );
      if (coordinatorRoute) {
        const d = z.object({ agentId: short.nullable() }).strict().parse(data);
        command = (s) =>
          coordination.configureCoordinator(
            s,
            user,
            coordinatorRoute[1],
            d.agentId,
          );
      }
      const resumeCoordinationRoute =
        /^\/api\/projects\/([^/]+)\/resume-coordination$/.exec(path);
      if (resumeCoordinationRoute) {
        z.object({}).strict().parse(data);
        command = (s) =>
          coordination.resumeCoordination(s, user, resumeCoordinationRoute[1]);
      }
      const decompose = /^\/api\/stories\/([^/]+)\/decompose$/.exec(path);
      if (decompose) {
        z.object({}).strict().parse(data);
        command = (s) =>
          coordination.requestDecomposition(s, user, decompose[1]);
      }
      const retrospect = /^\/api\/projects\/([^/]+)\/retrospect$/.exec(path);
      if (retrospect) {
        z.object({}).strict().parse(data);
        command = (s) =>
          coordination.requestRetrospective(s, user, retrospect[1]);
      }
      const coordinationRoute =
        /^\/api\/coordination\/([^/]+)\/(retry|acknowledge-stop)$/.exec(path);
      if (coordinationRoute) {
        z.object({}).strict().parse(data);
        command = (s) =>
          coordinationRoute[2] === "retry"
            ? coordination.retryCoordination(s, user, coordinationRoute[1])
            : coordination.acknowledgeCoordinationStop(
                s,
                user,
                coordinationRoute[1],
              );
      }
      const assessmentRoute =
        /^\/api\/tasks\/([^/]+)\/approve-assessment$/.exec(path);
      if (assessmentRoute) {
        z.object({}).strict().parse(data);
        command = (s) =>
          coordination.approveAssessment(s, user, assessmentRoute[1]);
      }
      const reviseAssessmentRoute =
        /^\/api\/tasks\/([^/]+)\/revise-assessment$/.exec(path);
      if (reviseAssessmentRoute) {
        const d = z
          .object({
            title: short,
            description: long,
            acceptance: long.trim().min(1),
            capability: z.enum(["coding", "writing"]),
            reason: z.string().trim().min(1).max(500),
            expectedRevision: z.number().int().min(1),
            failedJobId: short,
          })
          .strict()
          .parse(data);
        command = (s) =>
          reviseTaskAssessment(s, user, reviseAssessmentRoute[1], d);
      }
      if (path === "/api/profile") {
        const d = z
          .object({ maxConcurrency: z.number().int().min(1).max(8) })
          .strict()
          .parse(data);
        command = (s) => {
          const profile = s.users.find((u) => u.id === user)!;
          profile.maxConcurrency = d.maxConcurrency;
          return profile;
        };
      }
      if (path === "/api/projects") {
        const d = z
          .object({ name: short, description: long.optional(), organizationId: short.optional() })
          .strict()
          .parse(data);
        command = (s) => workflow.createProject(s, user, d.name, d.description, d.organizationId);
      }
      if (path === "/api/stories") {
        const d = z
          .object({
            projectId: short,
            boardId: short,
            title: short,
            description: long,
          })
          .strict()
          .parse(data);
        command = (s) => workflow.createStory(s, user, d);
      }
      const projectRoute = /^\/api\/projects\/([^/]+)\/(members|boards)$/.exec(
        path,
      );
      if (projectRoute) {
        if (projectRoute[2] === "members") {
          const d = z.object({ userId: short }).strict().parse(data);
          command = (s) =>
            workflow.addMember(s, user, projectRoute[1], d.userId);
        } else {
          const d = z.object({ name: short }).strict().parse(data);
          command = (s) =>
            workflow.createBoard(s, user, projectRoute[1], d.name);
        }
      }
      const publish = /^\/api\/stories\/([^/]+)\/publish$/.exec(path);
      if (publish) {
        const d = z
          .object({ tasks: z.array(draft).min(1).max(50) })
          .strict()
          .parse(data);
        command = (s) => workflow.publishStory(s, user, publish[1], d.tasks);
      }
      const agent = /^\/api\/agents\/([^/]+)$/.exec(path);
      if (agent) {
        const d = z
          .object({
            enabled: z.boolean().optional(),
            maxConcurrency: z.number().int().min(1).max(8).optional(),
            projectIds: z.array(short).max(100).optional(),
            difficultyRange: z
              .object({
                min: z.number().int().min(1).max(5),
                max: z.number().int().min(1).max(5),
              })
              .strict()
              .optional(),
          })
          .strict()
          .parse(data);
        command = (s) => workflow.editAgent(s, user, agent[1], d);
      }
      const task =
        /^\/api\/tasks\/([^/]+)\/(review|retry|cancel|acknowledge-stop)$/.exec(
          path,
        );
      if (task) {
        if (task[2] === "review") {
          const d = z
            .object({
              decision: z.enum(["approve", "reject"]),
              feedback: long.optional(),
            })
            .strict()
            .parse(data);
          command = (s) =>
            workflow.review(s, user, task[1], d.decision, d.feedback);
        } else {
          z.object({}).strict().parse(data);
          command = (s) =>
            task[2] === "retry"
              ? workflow.retry(s, user, task[1])
              : task[2] === "cancel"
                ? workflow.cancel(s, user, task[1])
                : workflow.acknowledgeStop(s, user, task[1]);
        }
      }
      if (!command)
        throw new workflow.DomainError("not_found", "接口不存在", 404);
      const hash = createHash("sha256")
        .update(path + "\n" + JSON.stringify(data))
        .digest("hex");
      const result = await repo.command(
        user,
        key,
        hash,
        (s) => command!(s) ?? { ok: true },
        (s, previous) => authorizeCommand(s, user, path, data, previous),
      );
      json(res, 200, result);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof workflow.DomainError)
        json(res, error.status, {
          error: { code: error.code, message: error.message },
        });
      else if (error instanceof z.ZodError)
        json(res, 400, {
          error: {
            code: "invalid",
            message:
              "输入不完整或格式无效：" +
              error.issues
                .map((i) => i.path.join("."))
                .slice(0, 3)
                .join("、"),
          },
        });
      else {
        console.error(
          "[api] request failed",
          error instanceof Error ? error.name : "unknown",
        );
        json(res, 500, {
          error: {
            code: "internal",
            message: "本地服务暂时不可用，请检查服务日志和数据库",
          },
        });
      }
    }
  });
}
