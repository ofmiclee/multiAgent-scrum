# MultiAgent Scrum

**English** · [简体中文](README.zh-CN.md)

A workspace for human-owned requirements, durable task scheduling, and local AI agent execution. People control requirements, permissions, and acceptance; existing agent harnesses execute the work.

The frontend uses React, TypeScript, and selected shadcn/ui components. The Node.js and PostgreSQL backend manages the workflow, while local Runners connect to execution providers through adapters.

- People confirm Stories before publishing their task breakdowns. Tasks can also be created independently.
- Project membership and Agent grants are separate. An online device does not automatically gain execution rights.
- Tasks move through Unclaimed, Assigned, Running, Awaiting acceptance, and Completed, or Execution failed.
- PostgreSQL is the authority for workflow state. An execution report is not business acceptance.

## Run locally

You need **Node.js ≥24.8.0**, npm, Docker Compose, and `/usr/bin/zip` (included with macOS; install the `zip` package on Linux). This runs the local account service and a real database without cloud credentials or model API keys.

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

Open [http://127.0.0.1:4399](http://127.0.0.1:4399) and register a local account. Development emails are captured locally instead of being sent: open the corresponding JSON file in `.runtime/identity-mail/`, then visit its `url` to verify your account. You can then sign in and create an organization and project. Keep this directory private because it contains verification links.

Generate `MAS_IDENTITY_SECRET` once and keep the same `.env` for later launches. The local service uses the `mas_next` database at `127.0.0.1:55439` with public development credentials. It does not read production database settings; this configuration is for local development only.

`npm run db:up` reuses an existing database container only if it carries this project's label, and refuses a conflicting container name. `npm run db:stop` stops the container without removing its data. Run `docker compose down -v` only if you intend to delete the local database.

## Development and checks

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:account-ui
```

Browser tests use isolated local API fixtures to check pages and interactions. They do not verify live agents or a production environment. `npm run dev` starts the account frontend's Vite development server; use the built local service above for the complete account flow.

## Build and install the macOS Runner

The source build targets **Apple silicon Macs running macOS 13.5 or later**. It requires Xcode Command Line Tools, Node.js ≥24.8.0, npm, and access to `nodejs.org` and the npm registry. Install Apple's command-line tools with `xcode-select --install` if needed. Intel builds are not included.

From the repository root:

```sh
npm ci
npm run package:runner:macos
```

The build compiles the Swift launcher in `apps/runner-macos/` and bundles the TypeScript Runner. It downloads official prebuilt dependencies: Node.js 24.22.3, Codex 0.162.1 for macOS arm64, and DSH 0.1.2-alpha.2. Node is pinned by SHA-256; npm runtime packages and their dependencies are pinned with integrity hashes under `deploy/runner/`. No private baseline ZIP or previously installed Runner is required. The project's launcher and Runner compile from source; the external runtimes retain their own licenses and build provenance.

The default output is `dist/runner/MultiAgent-Scrum-Runner-0.4.0-macos-arm64.dmg`, accompanied by `runner-release.json`. Packaging checks the app signature, native launcher self-test, isolated Runner status, runtime versions, and DMG integrity before completing.

Open the DMG, drag **MultiAgent Scrum Runner.app** into **Applications**, then launch it. The Runner appears in the menu bar. Sign in to the web workspace and start device connection. Approve the native connection prompt, compare the code displayed by the Runner with the browser, and confirm the connection in the web workspace. Configure your local execution-provider account and grant the Agent access to the project before running tasks.

Self-built apps use an ad-hoc signature; they are not Developer ID signed or notarized. Developer ID signing and notarization are separate release steps. An installed app can run its isolated self-test without connecting a real account:

```sh
"/Applications/MultiAgent Scrum Runner.app/Contents/MacOS/MASRunner" --self-test
```

To build for the local account service described above:

```sh
MAS_RUNNER_ORIGIN=http://127.0.0.1:4399 npm run package:runner:macos
```

## Execution and deployment scope

`services/runner/` and `packages/executors/` contain device connection, task execution, and harness adapter source. Live execution requires a locally configured provider account and explicit project authorization. Model calls may consume that account's quota. Local task execution is disabled by default.

Production cloud entry points and Runner HTTPS destinations retain their strict domain bindings. Building for the supported local service does not make arbitrary self-hosted HTTPS domains configurable. Production credentials, operational history, prebuilt installers, and automatic cloud-deployment scripts are not included in this repository.

## Repository layout

| Path | Contents |
| --- | --- |
| `apps/account/` | Account portal and Scrum workspace frontend |
| `apps/runner-macos/` | Swift menu-bar launcher and app metadata |
| `services/identity/` | Identity service, local entry point, and database migrations |
| `services/account/` | Organizations, projects, tasks, and access control |
| `services/runner/` | Local device connection and execution |
| `packages/domain/` | Workflow and execution contracts |
| `packages/executors/` | Execution provider adapters |
| `tests/` | Service and browser tests |

## License

Project-owned code is licensed under the [Apache License 2.0](LICENSE), which permits use, modification, and commercial redistribution and includes an express patent grant. Retain applicable license, copyright, and NOTICE files, and identify modified files when redistributing.

Third-party code, dependencies, and assets retain their own licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [NOTICE](NOTICE). Apache-2.0 does not grant rights to project names, trademarks, or third-party services.
