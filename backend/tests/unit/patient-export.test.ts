// Patient data export (Phase 8, issue #40): the pure parts — bundle
// format, the chunking memory bound, section-failure handling, the
// registry's wiring rules, and keyset pagination. Database-backed behaviour
// (ownership, lifecycle, expiry) is in tests/integration/patient-export.test.mts.
import { describe, expect, it } from 'vitest';
import {
  ChunkWriter,
  EXPORT_FORMAT,
  EXPORT_SCHEMA_VERSION,
  ExportSectionError,
  writeExportBundle,
} from '../../src/modules/patients/services/export-bundle';
import {
  listExportSections,
  paginate,
  registerExportSection,
  unregisterExportSection,
  type PatientExportSection,
} from '../../src/modules/patients/services/export-registry';

function memorySink() {
  const chunks: string[] = [];
  return {
    chunks,
    sink: {
      async writeChunk(seq: number, data: string) {
        expect(seq).toBe(chunks.length);
        chunks.push(data);
      },
    },
  };
}

function section(name: string, pages: unknown[][]): PatientExportSection {
  return {
    name,
    version: 1,
    async *pages() {
      for (const page of pages) yield page;
    },
  };
}

const subject = { patientProfileId: 'profile-1', userId: 'user-1' };
const generatedAt = new Date('2026-10-17T10:00:00.000Z');

describe('writeExportBundle', () => {
  it('writes a versioned, timestamped JSON document with every section in order', async () => {
    const { chunks, sink } = memorySink();
    const writer = new ChunkWriter(sink, 64 * 1024);
    await writeExportBundle({
      exportId: 'export-1',
      generatedAt,
      subject,
      sections: [section('alpha', [[{ a: 1 }, { a: 2 }], [{ a: 3 }]]), section('beta', [])],
      pageSize: 2,
      writer,
    });

    const bundle = JSON.parse(chunks.join(''));
    expect(bundle).toEqual({
      format: EXPORT_FORMAT,
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportId: 'export-1',
      generatedAt: '2026-10-17T10:00:00.000Z',
      sections: {
        alpha: { version: 1, items: [{ a: 1 }, { a: 2 }, { a: 3 }] },
        beta: { version: 1, items: [] },
      },
    });
    expect(writer.totalBytes).toBe(Buffer.byteLength(chunks.join('')));
    expect(writer.chunkCount).toBe(chunks.length);
  });

  it('flushes bounded chunks while paging, before later pages are fetched', async () => {
    const { chunks, sink } = memorySink();
    const writer = new ChunkWriter(sink, 200);
    const chunksSeenWhenPageRequested: number[] = [];
    const big: PatientExportSection = {
      name: 'big',
      version: 1,
      async *pages() {
        for (let page = 0; page < 10; page += 1) {
          chunksSeenWhenPageRequested.push(chunks.length);
          yield Array.from({ length: 5 }, (_, i) => ({ page, i, filler: 'x'.repeat(20) }));
        }
      },
    };
    await writeExportBundle({ exportId: 'e', generatedAt, subject, sections: [big], pageSize: 5, writer });

    expect(chunks.length).toBeGreaterThan(5);
    // Earlier output had already been handed to storage by the time later
    // pages were requested — the generator never holds the whole history.
    expect(chunksSeenWhenPageRequested.at(-1)).toBeGreaterThan(0);
    // Each chunk is at most the limit plus one serialized item.
    const maxItem = Buffer.byteLength(JSON.stringify({ page: 9, i: 4, filler: 'x'.repeat(20) })) + 1;
    for (const chunk of chunks) expect(Buffer.byteLength(chunk)).toBeLessThan(200 + maxItem);
    expect(JSON.parse(chunks.join('')).sections.big.items).toHaveLength(50);
  });

  it('aborts on a failing section with only the section name, never the message', async () => {
    const { sink } = memorySink();
    const failing: PatientExportSection = {
      name: 'broken',
      version: 1,
      async *pages() {
        yield [{ ok: true }];
        throw new Error('row for Jane Doe, DOB 1990-01-01 could not be read');
      },
    };
    const promise = writeExportBundle({
      exportId: 'e',
      generatedAt,
      subject,
      sections: [section('fine', [[{ x: 1 }]]), failing],
      pageSize: 10,
      writer: new ChunkWriter(sink, 1024),
    });
    await expect(promise).rejects.toBeInstanceOf(ExportSectionError);
    await expect(promise).rejects.toMatchObject({ section: 'broken', message: 'Export section "broken" failed.' });
  });

  it('handles multi-byte characters in the byte accounting', async () => {
    const { chunks, sink } = memorySink();
    const writer = new ChunkWriter(sink, 16);
    await writeExportBundle({
      exportId: 'e',
      generatedAt,
      subject,
      sections: [section('names', [[{ name: 'Adébáyọ̀ Ọlọ́run' }]])],
      pageSize: 1,
      writer,
    });
    expect(JSON.parse(chunks.join('')).sections.names.items[0].name).toBe('Adébáyọ̀ Ọlọ́run');
    expect(writer.totalBytes).toBe(Buffer.byteLength(chunks.join(''), 'utf8'));
  });
});

describe('ChunkWriter', () => {
  it('rejects a non-positive chunk size', () => {
    expect(() => new ChunkWriter(memorySink().sink, 0)).toThrow();
  });

  it('writes nothing for an empty flush', async () => {
    const { chunks, sink } = memorySink();
    const writer = new ChunkWriter(sink, 10);
    await writer.flush();
    expect(chunks).toHaveLength(0);
    expect(writer.chunkCount).toBe(0);
  });
});

describe('export registry', () => {
  it('lists sections sorted by name and treats re-registering the same object as a no-op', () => {
    const a = section('unit_zeta', []);
    const b = section('unit_alpha', []);
    registerExportSection(a);
    registerExportSection(b);
    registerExportSection(a);
    const names = listExportSections().map((s) => s.name);
    expect(names.indexOf('unit_alpha')).toBeLessThan(names.indexOf('unit_zeta'));
    expect(names.filter((n) => n === 'unit_zeta')).toHaveLength(1);
    unregisterExportSection('unit_zeta');
    unregisterExportSection('unit_alpha');
  });

  it('refuses a second, different section under an existing name', () => {
    registerExportSection(section('unit_dup', []));
    expect(() => registerExportSection(section('unit_dup', []))).toThrow(/already registered/);
    unregisterExportSection('unit_dup');
  });

  it('refuses names that are not stable lowercase keys', () => {
    expect(() => registerExportSection(section('Bad Name', []))).toThrow(/Invalid export section name/);
  });
});

describe('paginate', () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ id: `r${i}` }));
  const fetchPage = async (cursor: string | undefined, take: number) => {
    const start = cursor ? rows.findIndex((row) => row.id === cursor) + 1 : 0;
    return rows.slice(start, start + take);
  };

  it('walks every row exactly once with keyset cursors', async () => {
    const calls: (string | undefined)[] = [];
    const seen: string[] = [];
    for await (const page of paginate(
      3,
      (cursor, take) => {
        calls.push(cursor);
        return fetchPage(cursor, take);
      },
      (page) => page.map((row) => row.id),
    )) {
      expect(page.length).toBeLessThanOrEqual(3);
      seen.push(...page);
    }
    expect(seen).toEqual(rows.map((row) => row.id));
    expect(calls).toEqual([undefined, 'r2', 'r5']);
  });

  it('stops after a full final page with one empty fetch', async () => {
    const pages: string[][] = [];
    for await (const page of paginate(7, fetchPage, (p) => p.map((row) => row.id))) pages.push(page);
    expect(pages).toHaveLength(1);
  });

  it('rejects an invalid page size', async () => {
    const iterator = paginate(0, fetchPage, (p) => p);
    await expect(iterator.next()).rejects.toThrow(/pageSize/);
  });
});
