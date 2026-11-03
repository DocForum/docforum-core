// Test-only wrapper around embedded-postgres, aliased in vitest.config.mts.
//
// Plain embedded-postgres makes the connecting user a superuser, and superusers
// ignore row-level security. Managed hosts such as Render instead provide a
// database owner with CREATEROLE but no SUPERUSER or BYPASSRLS. This wrapper
// keeps a separate admin for cluster setup and gives test files that kind of
// owner, so CI exercises the same permissions as a deployment.
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
  createDatabase(name: string): Promise<void>;
  getPgClient(database?: string, host?: string): PgClient;
};

const realModulePath = path.resolve(process.cwd(), 'node_modules/embedded-postgres/dist/index.js');
const { default: RealEmbeddedPostgres } = (await import(
  /* @vite-ignore */ pathToFileURL(realModulePath).href
)) as { default: EmbeddedPostgresClass };

const ADMIN_USER = 'pgadmin';
const quoteIdentifier = (value: string) => `"${value.replace(/"/g, '""')}"`;
const quoteLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;

export default class RestrictedEmbeddedPostgres extends RealEmbeddedPostgres {
  readonly #ownerUser: string;
  readonly #ownerPassword: string;

  constructor(options: EmbeddedPostgresOptions = {}) {
    const ownerUser = options.user ?? 'docforum';
    const ownerPassword = options.password ?? 'docforum';
    super({ ...options, user: ADMIN_USER, password: ADMIN_USER });
    this.#ownerUser = ownerUser;
    this.#ownerPassword = ownerPassword;
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
    await super.start();
    await this.#asAdmin(
      `CREATE ROLE ${quoteIdentifier(this.#ownerUser)} LOGIN PASSWORD ${quoteLiteral(this.#ownerPassword)} ` +
        'CREATEDB CREATEROLE NOSUPERUSER NOBYPASSRLS',
    );
  }

  override async createDatabase(name: string): Promise<void> {
    await this.#asAdmin(`CREATE DATABASE ${quoteIdentifier(name)} OWNER ${quoteIdentifier(this.#ownerUser)}`);
  }
}
