import pg from "pg";
import { isDeepStrictEqual } from "node:util";
import type { State } from "../../packages/domain/contracts.ts";
import { createSeed, DomainError } from "../../packages/domain/workflow.ts";

export const LOCAL_DATABASE_URL =
  "postgres://mas_local:mas_local_dev_only@127.0.0.1:55439/mas_next";

/** This store creates preview tables and demo identities. Never pass a cloud
 * URL through pg's connection-string parser (query fields override the host).
 * A local tunnel can still reach a remote database: operators must not tunnel
 * a production database into the preview's approved loopback endpoint. */
function previewDatabaseConfig(value: string): pg.PoolConfig {
  try {
    if (process.env.NODE_ENV === 'production' || /[\s\p{Cc}]/u.test(value)) throw Error();
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' ||
        !url.port || url.search || url.hash || !url.username || !url.password ||
        !/^\/[^/]+$/.test(url.pathname) || /[?#]/.test(value)) throw Error();
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error();
    const user = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
    const database = decodeURIComponent(url.pathname.slice(1));
    if ([user, password, database].some(v => !v || /\p{Cc}/u.test(v)) || database.includes('/')) throw Error();
    return {host: '127.0.0.1', port, user, password, database, ssl: false, sslnegotiation: 'postgres'};
  } catch {
    // No URL, hostname, username, password, or raw parser error in logs.
    throw Error('Local preview requires explicit credentials and database at postgres://127.0.0.1:port; production and URL options are forbidden');
  }
}

/** Local-preview aggregate. One row lock is the scheduling/capacity boundary.
 * Deliberately not the production multi-tenant storage design. */
export class Repository {
  readonly pool: pg.Pool;
  private closed = false;
  constructor(
    url = LOCAL_DATABASE_URL,
    readonly key = "local-preview",
  ) {
    this.pool = new pg.Pool({
      ...previewDatabaseConfig(url),
      max: 10,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
      application_name: "mas-next-local",
    });
  }
  async initialize() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS mas_preview_workspace (
      workspace_key text PRIMARY KEY,
      schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
      revision bigint NOT NULL DEFAULT 0,
      state jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await this.pool.query(
      "INSERT INTO mas_preview_workspace (workspace_key, state) VALUES ($1, $2::jsonb) ON CONFLICT (workspace_key) DO NOTHING",
      [this.key, JSON.stringify(createSeed())],
    );
    // Explicit compatibility upgrade for old *local preview* aggregates only.
    // Partial/new authorization records must never regain membership implicitly.
    await this.mutate(s => {
      if (Object.hasOwn(s, 'organizations') || Object.hasOwn(s, 'organizationMemberships') ||
          s.projects.some(p => Object.hasOwn(p, 'organizationId'))) return;
      s.organizations = [{id: 'org-preview', name: '本地测试组织'}];
      s.organizationMemberships = s.users.map(u => ({
        organizationId: 'org-preview', userId: u.id, status: 'active',
      }));
      for (const p of s.projects) p.organizationId = 'org-preview';
    });
  }
  async read(): Promise<State> {
    const result = await this.pool.query(
      "SELECT state FROM mas_preview_workspace WHERE workspace_key=$1",
      [this.key],
    );
    if (!result.rows[0]) throw new Error("Workspace not initialized");
    const state = result.rows[0].state as State;
    state.coordinationJobs ??= [];
    return state;
  }
  async mutate<T>(operation: (state: State) => T): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = await client.query(
        "SELECT state FROM mas_preview_workspace WHERE workspace_key=$1 FOR UPDATE",
        [this.key],
      );
      if (!row.rows[0]) throw new Error("Workspace not initialized");
      const before = row.rows[0].state as State;
      const next = structuredClone(before);
      next.coordinationJobs ??= [];
      const result = operation(next);
      if (!isDeepStrictEqual(before, next)) {
        next.revision++;
        await client.query(
          "UPDATE mas_preview_workspace SET state=$2::jsonb, revision=$3, updated_at=now() WHERE workspace_key=$1",
          [this.key, JSON.stringify(next), next.revision],
        );
      }
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async command<T>(
    actor: string,
    key: string,
    hash: string,
    operation: (state: State) => T,
    authorize?: (state: State, previous: unknown) => void,
  ): Promise<T> {
    return this.mutate((s) => {
      const fullKey = `${actor}:${key}`;
      const previous = s.commands[fullKey];
      authorize?.(s, previous?.result);
      if (previous) {
        if (previous.hash !== hash)
          throw new DomainError(
            "idempotency_conflict",
            "幂等键对应的请求内容不同",
            409,
          );
        return previous.result as T;
      }
      if (Object.keys(s.commands).length >= 10000)
        throw new DomainError(
          "preview_limit",
          "本地预览命令记录已满，需要归档后继续",
          409,
        );
      const result = operation(s);
      s.commands[fullKey] = { hash, result: result ?? { ok: true } };
      return result;
    });
  }
  /** A dedicated connection holds the local Runner leader lock for its lifetime. */
  async lockRunner() {
    const client = await this.pool.connect();
    const result = await client.query(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [`mas-runner:${this.key}`],
    );
    if (!result.rows[0].locked) {
      client.release();
      throw new Error("Another local Runner already owns this workspace");
    }
    return client;
  }
  async close() {
    if (!this.closed) {
      this.closed = true;
      await this.pool.end();
    }
  }
}
