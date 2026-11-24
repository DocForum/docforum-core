// Issue #329: GET /payments/facility/ledger.csv — the facility ledger as a
// streamed CSV download. Real embedded Postgres, real HTTP. Asserts the
// CSV rows equal the JSON endpoint's rows under the same filters, that a
// multi-page export walks every page, that cells starting with = + - @ are
// neutralised, and that the endpoint is facility-scoped.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import EmbeddedPostgres from 'embedded-postgres';
import { createOrderFixture } from './order-fixtures.mjs';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5483; // unique per integration file
const runId = Date.now();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-ledger-csv-pg-'));
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'docforum', password: 'docforum', port: PORT, persistent: false });
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_ledger_csv_test`;

const HEADER = 'date,intent_id,status,asset,amount_smallest_unit,amount,transaction_hash';

/** Minimal RFC 4180 parser for assertions (handles quoted cells/CRLF). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i += 1; }
    else cell += ch;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

describe('facility ledger CSV export (issue #329)', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  let ledgerCsv: typeof import('../../src/modules/payments/services/ledger-csv.js');
  let patient: { id: string; token: string };
  let facilityA: { id: string; token: string };
  let facilityB: { id: string; token: string };

  const token = (id: string, role: 'patient' | 'facility') =>
    jwt.sign({ sub: id, role }, 'test-access-secret', { expiresIn: '15m' });

  async function createIntent(input: {
    facilityId: string;
    status: 'created' | 'escrowed' | 'released' | 'refunded';
    amount: bigint;
    createdAt: Date;
    assetCode?: string;
    stellarTxHash?: string | null;
  }) {
    const order = await createOrderFixture(prisma, {
      patientProfileId: patient.id,
      facilityProfileId: input.facilityId,
      kind: 'lab_order',
      amountStroops: input.amount,
      tag: `ledger-csv-${runId}-${Math.random().toString(36).slice(2)}`,
    });
    return prisma.paymentIntent.create({
      data: {
        labOrderId: order.id,
        patientProfileId: patient.id,
        facilityId: input.facilityId,
        status: input.status,
        amount: input.amount,
        assetCode: input.assetCode ?? 'XLM',
        createdAt: input.createdAt,
        stellarTxHash: input.stellarTxHash === undefined ? 'a'.repeat(64) : input.stellarTxHash,
      },
    });
  }

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_ledger_csv_test');
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
    process.env.DATABASE_URL = databaseUrl;

    prisma = (await import('../../src/db/prisma-client.js')).prisma;
    app = (await import('../../src/app.js')).createApp();
    ledgerCsv = await import('../../src/modules/payments/services/ledger-csv.js');

    const patientUser = await prisma.user.create({
      data: { email: `ledger-csv-patient-${runId}@example.com`, passwordHash: 'unused', role: 'patient' },
    });
    const profile = await prisma.patientProfile.create({ data: { userId: patientUser.id, fullName: 'CSV Patient' } });
    patient = { id: profile.id, token: token(patientUser.id, 'patient') };

    async function makeFacility(label: string) {
      const user = await prisma.user.create({
        data: { email: `${label}-${runId}@example.com`, passwordHash: 'unused', role: 'facility' },
      });
      const facility = await prisma.facilityProfile.create({ data: { userId: user.id, name: label, type: 'lab' } });
      return { id: facility.id, token: token(user.id, 'facility') };
    }
    [facilityA, facilityB] = await Promise.all([makeFacility('ledger-csv-a'), makeFacility('ledger-csv-b')]);

    const base = Date.parse('2026-06-01T12:00:00.000Z');
    const at = (minutes: number) => new Date(base + minutes * 60_000);
    // Facility A: 7 rows across statuses, assets and hostile tx-hash cells.
    await createIntent({ facilityId: facilityA.id, status: 'escrowed', amount: 9_007_199_254_740_993n, createdAt: at(0) });
    await createIntent({ facilityId: facilityA.id, status: 'released', amount: 12_345_678n, createdAt: at(1), stellarTxHash: '=HYPERLINK("http://evil","x")' });
    await createIntent({ facilityId: facilityA.id, status: 'refunded', amount: 30n, createdAt: at(2), stellarTxHash: '+1+1' });
    await createIntent({ facilityId: facilityA.id, status: 'released', amount: 40n, createdAt: at(3), stellarTxHash: '-2+3' });
    await createIntent({ facilityId: facilityA.id, status: 'created', amount: 50n, createdAt: at(4), stellarTxHash: '@SUM(1,2)' });
    await createIntent({ facilityId: facilityA.id, status: 'released', amount: 60_000_000n, createdAt: at(5), assetCode: 'USDC' });
    await createIntent({ facilityId: facilityA.id, status: 'created', amount: 70n, createdAt: at(6), stellarTxHash: null });
    // Facility B: must never appear in A's export.
    await createIntent({ facilityId: facilityB.id, status: 'released', amount: 999n, createdAt: at(3) });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function jsonLedgerAll(query: Record<string, string>) {
    const items: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    do {
      const res = await request(app)
        .get('/payments/facility/ledger')
        .query({ ...query, limit: 2, ...(cursor ? { cursor } : {}) })
        .set('Authorization', `Bearer ${facilityA.token}`);
      expect(res.status).toBe(200);
      items.push(...res.body.items);
      cursor = res.body.nextCursor ?? undefined;
    } while (cursor);
    return items;
  }

  async function csvLedger(query: Record<string, string>, who = facilityA.token) {
    return request(app)
      .get('/payments/facility/ledger.csv')
      .query(query)
      .set('Authorization', `Bearer ${who}`)
      .buffer(true)
      .parse((res, done) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { text += chunk; });
        res.on('end', () => done(null, text));
      });
  }

  /** Undo the formula guard so a cell can be compared to the JSON value. */
  const unguard = (cell: string) => (/^'[=+\-@\t\r]/.test(cell) ? cell.slice(1) : cell);

  it.each([
    [{}],
    [{ status: 'released' }],
    [{ from: '2026-06-01T12:02:00.000Z', to: '2026-06-01T12:05:00.000Z' }],
  ])('CSV rows match the JSON ledger rows for filters %j', async (query) => {
    const [json, csv] = await Promise.all([jsonLedgerAll(query), csvLedger(query)]);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csv.headers['content-disposition']).toBe('attachment; filename="facility-ledger.csv"');

    const rows = parseCsv(csv.body as string);
    expect(rows[0]!.join(',')).toBe(HEADER);
    const data = rows.slice(1);
    expect(data).toHaveLength(json.length);
    expect(json.length).toBeGreaterThan(0);
    data.forEach((row, i) => {
      const item = json[i]!;
      expect(row[0]).toBe(new Date(item.createdAt as string).toISOString());
      expect(row[1]).toBe(item.id);
      expect(row[2]).toBe(item.status);
      expect(row[3]).toBe(item.assetCode);
      expect(row[4]).toBe(item.amount);
      expect(unguard(row[6]!)).toBe(item.stellarTxHash ?? '');
    });
  });

  it('formats the decimal amount exactly from the asset decimals', async () => {
    const rows = parseCsv((await csvLedger({})).body as string).slice(1);
    const byAmount = new Map(rows.map((row) => [row[4], row[5]]));
    expect(byAmount.get('9007199254740993')).toBe('900719925.4740993');
    expect(byAmount.get('12345678')).toBe('1.2345678');
    expect(byAmount.get('60000000')).toBe('6.0000000'); // USDC, 7 decimals
  });

  it('escapes cells starting with =, +, - or @ (formula injection)', async () => {
    const raw = (await csvLedger({})).body as string;
    const hashes = parseCsv(raw).slice(1).map((row) => row[6]!);
    expect(hashes).toContain('\'=HYPERLINK("http://evil","x")');
    expect(hashes).toContain("'+1+1");
    expect(hashes).toContain("'-2+3");
    expect(hashes).toContain("'@SUM(1,2)");
    // No raw cell anywhere in the file begins with a formula trigger.
    for (const cell of parseCsv(raw).flat()) expect(cell).not.toMatch(/^[=+\-@]/);
  });

  it('never leaks another facility\'s rows', async () => {
    const rows = parseCsv((await csvLedger({})).body as string).slice(1);
    expect(rows.map((row) => row[4])).not.toContain('999');
    const b = parseCsv((await csvLedger({}, facilityB.token)).body as string).slice(1);
    expect(b).toHaveLength(1);
    expect(b[0]![4]).toBe('999');
  });

  it('streams page by page: a small page size yields one chunk per page and the same rows', async () => {
    const chunks: string[] = [];
    for await (const chunk of ledgerCsv.facilityLedgerCsvChunks(facilityA.id, {}, 2)) chunks.push(chunk);
    // header + ceil(7 / 2) = 4 pages
    expect(chunks).toHaveLength(5);
    const http = (await csvLedger({})).body as string;
    expect(chunks.join('')).toBe(http);
  });

  it('rejects non-facility callers and unknown query parameters', async () => {
    expect((await csvLedger({}, patient.token)).status).toBe(403);
    expect((await csvLedger({ limit: '5' })).status).toBe(400);
    expect((await csvLedger({ from: '2026-06-02', to: '2026-06-01' })).status).toBe(400);
  });
});
