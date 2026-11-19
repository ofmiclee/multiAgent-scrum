# MultiAgent Scrum

A workspace for human-owned requirements, durable task scheduling, and local AI agent execution. People control requirements, permissions, and acceptance; existing agent harnesses execute the work.

MultiAgent Scrum 将需求、任务调度与本机 Agent 执行分开。前端使用 React、TypeScript 和部分 shadcn/ui 组件；服务端使用 Node.js、PostgreSQL；Runner 通过适配器连接现有执行器。

- Story 由人确认，拆分发布后生成任务，也可以直接创建独立任务。
- 项目成员权限与 Agent 授权分别管理，设备在线不等于获得执行权限。
- 任务状态为：待领取、已分配、执行中、待验收、已完成、执行失败。
- 工作流状态以 PostgreSQL 为准；执行报告不等于业务验收。

## 本地运行

需要 **Node.js ≥24.8.0**、npm、Docker Compose，以及 `/usr/bin/zip`（macOS 自带；Linux 可安装 `zip` 包）。以下流程运行真实本地账号服务与数据库，不需要云服务或模型密钥。

```sh
git clone https://github.com/ofmiclee/multiAgent-scrum.git
cd multiAgent-scrum
npm ci
cp .env.example .env
chmod 600 .env
node -e "require('node:fs').appendFileSync('.env', 'MAS_IDENTITY_SECRET=' + require('node:crypto').randomBytes(32).toString('hex') + '\n')"
npm run db:up
npm run identity:local -- init
npm run build
npm start
```

打开 [http://127.0.0.1:4399](http://127.0.0.1:4399)，注册本地账号。开发邮件不会发送到外部邮箱：在 `.runtime/identity-mail/` 中打开对应 JSON 文件，将其中的 `url` 粘贴到浏览器完成验证，然后登录、创建组织和项目。该目录包含验证链接，请勿上传或共享。

`MAS_IDENTITY_SECRET` 只需生成一次，后续启动沿用同一个 `.env`。本地服务固定使用 `127.0.0.1:55439` 的 `mas_next` 数据库及公开开发账号，不读取生产数据库配置；这些配置仅供本地使用。

`npm run db:up` 会复用带有本项目标签的已有数据库容器，遇到同名其他容器会拒绝操作。`npm run db:stop` 停止容器并保留数据。请勿执行 `docker compose down -v`，除非确实要删除本地数据库。

## 开发与验证

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:account-ui
```

浏览器测试使用独立的本地模拟接口，验证页面和交互，不代表真实 Agent 或生产环境验证。`npm run dev` 启动账号前端 Vite 开发服务；完整账号流程以上面的构建后本地服务为准。

## Runner 与部署范围

`services/runner/` 和 `packages/executors/` 包含设备连接、任务执行与 Harness 适配源码。真实执行需要另行安装受支持的执行器、配置本机账号，并由项目成员明确授权；模型调用可能使用对应账号额度。本地默认不开启任务执行。

**当前公开源码不能独立生成 macOS Runner 安装包。** `npm run package:runner:macos` 保留原有打包实现，但依赖未包含的私有基线 ZIP（原生启动壳、Node 和 DSH 运行时）；原生启动壳源码也不在本次发布中。第三方执行器和二进制的许可不由本项目许可证替代。

云端入口和 Runner 的 HTTPS 目的地保留现有的严格域名绑定。它们是当前产品部署的实现参考，尚不是可直接配置任意域名的自托管部署方案；本地账号入口不依赖这些云端绑定。公开仓库不包含生产凭据、运维历史、安装包或自动发布脚本。

## 目录

| 路径 | 内容 |
| --- | --- |
| `apps/account/` | 账号与 Scrum 工作区前端 |
| `services/identity/` | 身份服务、本地入口和数据库迁移 |
| `services/account/` | 组织、项目、任务与权限服务 |
| `services/runner/` | 本机设备连接和执行流程 |
| `packages/domain/` | 工作流和执行协议 |
| `packages/executors/` | 执行器适配 |
| `tests/` | 服务与浏览器测试 |

## 开源协议

项目自有代码采用 [Apache License 2.0](LICENSE)，允许使用、修改和商业分发，并包含明确的专利授权条款。分发时应保留适用的许可证、版权及 NOTICE，标注修改。

第三方代码、依赖和素材保留各自许可证，详见 [第三方声明](THIRD_PARTY_NOTICES.md) 与 [NOTICE](NOTICE)。Apache-2.0 不授予项目名称、商标或第三方服务的使用权。
