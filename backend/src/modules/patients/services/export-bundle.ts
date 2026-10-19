// Writes the patient export bundle (Phase 8, issue #40) as a stream of
// bounded text chunks. Pure apart from the injected sink, so the format and
// the memory bound are unit-tested without a database.
//
// Bundle layout (schemaVersion 1):
//   {
//     "format": "docforum.patient-export",
//     "schemaVersion": 1,
//     "exportId": "<uuid>",
//     "generatedAt": "<ISO-8601>",
//     "sections": {
//       "<name>": { "version": <int>, "items": [ ... ] },
//       ...
//     }
//   }
import type { ExportSubject, PatientExportSection } from './export-registry';

export const EXPORT_FORMAT = 'docforum.patient-export';
export const EXPORT_SCHEMA_VERSION = 1;

export interface ChunkSink {
  writeChunk(seq: number, data: string): Promise<void>;
}

/** Buffers writes and hands the sink a chunk once the buffer reaches
 * `maxChunkBytes`. A chunk can exceed the limit by at most one write (one
 * serialized item), so memory stays bounded by limit + largest item. */
export class ChunkWriter {
  private buffer: string[] = [];
  private bufferBytes = 0;
  private nextSeq = 0;
  private written = 0;

  constructor(
    private readonly sink: ChunkSink,
    private readonly maxChunkBytes: number,
  ) {
    if (!Number.isInteger(maxChunkBytes) || maxChunkBytes < 1) {
      throw new Error('maxChunkBytes must be a positive integer.');
    }
  }

  async write(text: string): Promise<void> {
    this.buffer.push(text);
    this.bufferBytes += Buffer.byteLength(text, 'utf8');
    if (this.bufferBytes >= this.maxChunkBytes) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.bufferBytes === 0) return;
    const data = this.buffer.join('');
    const seq = this.nextSeq;
    this.buffer = [];
    this.bufferBytes = 0;
    await this.sink.writeChunk(seq, data);
    this.nextSeq += 1;
    this.written += Buffer.byteLength(data, 'utf8');
  }

  get chunkCount(): number {
    return this.nextSeq;
  }

  get totalBytes(): number {
    return this.written;
  }
}

/** Raised when one section fails. Carries only the section name — the
 * underlying error stays server-side, since its message may echo data. */
export class ExportSectionError extends Error {
  constructor(
    public readonly section: string,
    public readonly cause: unknown,
  ) {
    super(`Export section "${section}" failed.`);
    this.name = 'ExportSectionError';
  }
}

export interface WriteBundleInput {
  exportId: string;
  generatedAt: Date;
  subject: ExportSubject;
  sections: PatientExportSection[];
  pageSize: number;
  writer: ChunkWriter;
}

/** Streams every section into the writer. Any section failure aborts the
 * whole bundle — a partial export must never be published as complete. */
export async function writeExportBundle(input: WriteBundleInput): Promise<void> {
  const { writer } = input;
  await writer.write(
    `{"format":${JSON.stringify(EXPORT_FORMAT)},"schemaVersion":${EXPORT_SCHEMA_VERSION},` +
      `"exportId":${JSON.stringify(input.exportId)},"generatedAt":${JSON.stringify(input.generatedAt.toISOString())},` +
      `"sections":{`,
  );

  for (const [index, section] of input.sections.entries()) {
    await writer.write(
      `${index === 0 ? '' : ','}${JSON.stringify(section.name)}:{"version":${section.version},"items":[`,
    );
    let first = true;
    try {
      for await (const page of section.pages(input.subject, input.pageSize)) {
        for (const item of page) {
          await writer.write((first ? '' : ',') + JSON.stringify(item));
          first = false;
        }
      }
    } catch (err) {
      throw new ExportSectionError(section.name, err);
    }
    await writer.write(']}');
  }

  await writer.write('}}');
  await writer.flush();
}
