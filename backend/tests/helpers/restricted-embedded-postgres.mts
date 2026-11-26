// Test-only wrapper around embedded-postgres, aliased in vitest.config.mts.
//
// Plain embedded-postgres makes the connecting user a superuser, and superusers
// ignore row-level security. Managed hosts such as Render instead provide a
// database owner with CREATEROLE but no SUPERUSER or BYPASSRLS. This wrapper
// keeps a separate admin for cluster setup and gives test files that kind of
// owner, so CI exercises the same permissions as a deployment.
//
// It also holds a per-port lock from start() to stop(). Integration files pick
// a fixed `const PORT`, and two files on the same port used to time out in
// beforeAll ("Hook timed out") when vitest ran them in parallel. Now the
// second file waits for the first to stop its cluster, so a reused port costs
// a few seconds instead of a red build. Distinct ports are still faster.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type PgClient = {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
};
type EmbeddedPostgresOptions = Record<string, unknown> & { user?: string; password?: string };
type EmbeddedPostgresClass = new (options?: EmbeddedPostgresOptions) => {
  start(): Promise<void>;
  stop(): Promise<void>;
  createDatabase(name: string): Promise<void>;
  getPgClient(database?: string, host?: string): PgClient;
};

const realModulePath = path.resolve(process.cwd(), 'node_modules/embedded-postgres/dist/index.js');
const { default: RealEmbeddedPostgres } = (await import(
  /* @vite-ignore */ pathToFileURL(realModulePath).href
)) as { default: EmbeddedPostgresClass };

const ADMIN_USER = 'pgadmin';

// Long enough to outlast another file's whole run (~15-40s in CI), short
// enough to fail inside vitest's 120s hookTimeout with a clear message.
const PORT_LOCK_WAIT_MS = 100_000;
const portLockPath = (port: number) => path.join(os.tmpdir(), `docforum-embedded-pg-${port}.lock`);

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

async function acquirePortLock(port: number): Promise<() => void> {
  const lockPath = portLockPath(port);
  const deadline = Date.now() + PORT_LOCK_WAIT_MS;
  let warned = false;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      const release = () => {
        process.off('exit', release);
        try {
          if (fs.readFileSync(lockPath, 'utf8') === String(process.pid)) fs.unlinkSync(lockPath);
        } catch {
          // Already gone.
        }
      };
      process.on('exit', release);
      return release;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let holder: number;
    try {
      holder = Number(fs.readFileSync(lockPath, 'utf8').trim());
    } catch {
      continue; // Released between our two calls: try again.
    }
    // A lock left by a crashed run (its process is gone) is stale.
    if (!holder || !isAlive(holder)) {
      fs.rmSync(lockPath, { force: true });
      continue;
    }
    if (!warned) {
      warned = true;
      console.warn(`Embedded Postgres port ${port} is in use by another test file (pid ${holder}); waiting for it to stop.`);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Embedded Postgres port ${port} is still held by another test file (pid ${holder}) after ` +
          `${PORT_LOCK_WAIT_MS / 1000}s. Give this file its own \`const PORT\`.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
const quoteIdentifier = (value: string) => `"${value.replace(/"/g, '""')}"`;
const quoteLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;

export default class RestrictedEmbeddedPostgres extends RealEmbeddedPostgres {
  readonly #ownerUser: string;
  readonly #ownerPassword: string;
  readonly #port: number;
  #releasePort: (() => void) | null = null;

  constructor(options: EmbeddedPostgresOptions = {}) {
    const ownerUser = options.user ?? 'docforum';
    const ownerPassword = options.password ?? 'docforum';
    super({ ...options, user: ADMIN_USER, password: ADMIN_USER });
    this.#ownerUser = ownerUser;
    this.#ownerPassword = ownerPassword;
    this.#port = typeof options.port === 'number' ? options.port : 5432;
  }

  async #asAdmin(sql: string): Promise<void> {
    const client = this.getPgClient();
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  override async start(): Promise<void> {
    this.#releasePort ??= await acquirePortLock(this.#port);
    try {
      await super.start();
    } catch (error) {
      this.#releasePort();
      this.#releasePort = null;
      throw error;
    }
    await this.#asAdmin(
      `CREATE ROLE ${quoteIdentifier(this.#ownerUser)} LOGIN PASSWORD ${quoteLiteral(this.#ownerPassword)} ` +
        'CREATEDB CREATEROLE NOSUPERUSER NOBYPASSRLS',
    );
  }

  override async stop(): Promise<void> {
    try {
      await super.stop();
    } catch (_err) {
      // On Windows, background processes may still hold file locks when super.stop() tries to rmdir
    } finally {
      this.#releasePort?.();
      this.#releasePort = null;
    }
  }

  override async createDatabase(name: string): Promise<void> {
    await this.#asAdmin(`CREATE DATABASE ${quoteIdentifier(name)} OWNER ${quoteIdentifier(this.#ownerUser)}`);
  }
}
