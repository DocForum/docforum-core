import { readdirSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { prisma } from '../db/prisma-client';

export type ReadinessResult = {
  status: 'ready' | 'not_ready';
  checks: {
    configuration: 'ok' | 'failed';
    database: 'ok' | 'failed';
    migrations: 'ok' | 'pending' | 'failed';
    payments: 'disabled' | 'reachable' | 'unavailable';
  };
};

export type ReadinessChecks = {
  configuration: () => Promise<void>;
  database: () => Promise<void>;
  migrations: () => Promise<void>;
  payments: () => Promise<'disabled' | 'reachable' | 'unavailable'>;
};

const CACHE_MS = 3_000;

function latestMigrationName(): string {
  const directory = path.resolve(process.cwd(), 'prisma/migrations');
  const migrations = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const latest = migrations.at(-1);
  if (!latest) throw new Error('No Prisma migrations are present.');
  return latest;
}

const defaultChecks: ReadinessChecks = {
  async configuration() {
    if (!config.databaseUrl || !config.jwt.accessSecret || !config.jwt.refreshSecret) {
      throw new Error('Required configuration is missing.');
    }
  },
  async database() {
    await prisma.$queryRaw`SELECT 1`;
  },
  async migrations() {
    const expected = latestMigrationName();
    const [latest, unfinished] = await Promise.all([
      prisma.$queryRaw<{ migration_name: string }[]>`
        SELECT migration_name FROM "_prisma_migrations"
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
        ORDER BY migration_name DESC LIMIT 1
      `,
      prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*) AS count FROM "_prisma_migrations"
        WHERE finished_at IS NULL AND rolled_back_at IS NULL
      `,
    ]);
    if (latest[0]?.migration_name !== expected || Number(unfinished[0]?.count ?? 0) > 0) {
      throw new Error('Database migrations are not at the expected version.');
    }
  },
  async payments() {
    if (!config.payments.activeContractId) return 'disabled';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1_000);
    try {
      const response = await fetch(config.payments.sorobanRpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
        signal: controller.signal,
      });
      if (!response.ok) return 'unavailable';
      const body = (await response.json()) as { result?: unknown; error?: unknown };
      return body.error || body.result === undefined ? 'unavailable' : 'reachable';
    } catch {
      return 'unavailable';
    } finally {
      clearTimeout(timeout);
    }
  },
};

export function createReadinessChecker(checks: ReadinessChecks, cacheMs = CACHE_MS) {
  let cached: { expiresAt: number; value: ReadinessResult } | undefined;
  let inFlight: Promise<ReadinessResult> | undefined;

  return async function getReadiness(): Promise<ReadinessResult> {
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (inFlight) return inFlight;

    const pending: Promise<ReadinessResult> = (async () => {
      const [configuration, database, migrations, payments] = await Promise.all([
        checks.configuration().then(() => 'ok' as const, () => 'failed' as const),
        checks.database().then(() => 'ok' as const, () => 'failed' as const),
        checks.migrations().then(() => 'ok' as const, () => 'pending' as const),
        checks.payments(),
      ]);
      const ready = configuration === 'ok' && database === 'ok' && migrations === 'ok';
      const result: ReadinessResult = {
        status: ready ? 'ready' : 'not_ready',
        checks: { configuration, database, migrations, payments },
      };
      return result;
    })().finally(() => {
      inFlight = undefined;
    });
    inFlight = pending;

    const value = await pending;
    cached = { expiresAt: Date.now() + cacheMs, value };
    return value;
  };
}

export const getReadiness = createReadinessChecker(defaultChecks);
