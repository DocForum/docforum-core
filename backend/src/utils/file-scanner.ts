// Pluggable malware scanning for uploaded clinical files (issue #324).
//
// Scan results:
//   clean    — scanner found nothing; upload may proceed
//   infected — scanner identified malware; upload must be refused
//   error    — scanner is unavailable or returned an unexpected response;
//              callers apply the fail-open / fail-closed policy from config
//
// Two adapters ship: NoOpFileScanner (default; passes everything — suitable
// for development and unit tests that don't want real scanner deps) and
// ClamAvFileScanner (clamd TCP INSTREAM protocol; suitable for production).
// The active adapter is chosen by config (FILE_SCANNING_CLAMAV_ENABLED).
// Tests can inject a fake adapter via setFileScannerForTests.
import * as net from 'node:net';
import { config } from '../config';

export type ScanResult = 'clean' | 'infected' | 'error';

export interface FileScanner {
  scan(body: Buffer): Promise<ScanResult>;
}

export class NoOpFileScanner implements FileScanner {
  async scan(_body: Buffer): Promise<ScanResult> {
    return 'clean';
  }
}

/** ClamAV clamd TCP client using the INSTREAM command.
 * Sends a chunk-framed stream and reads the single-line response. */
export class ClamAvFileScanner implements FileScanner {
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs = 10_000,
  ) {}

  scan(body: Buffer): Promise<ScanResult> {
    // Only a real Buffer can be framed for INSTREAM; anything else is a scan
    // error, so callers apply the fail-open / fail-closed policy.
    if (!Buffer.isBuffer(body)) return Promise.resolve('error');
    // INSTREAM: send "zINSTREAM\0", then 4-byte big-endian length + data, then 4-byte zero to end.
    // Built here, right after the Buffer check, so the frame is only ever made from a Buffer.
    const lengthBuf = Buffer.alloc(4);
    lengthBuf.writeUInt32BE(body.byteLength, 0);
    const frame = Buffer.concat([Buffer.from('zINSTREAM\0'), lengthBuf, body, Buffer.alloc(4)]);
    return new Promise((resolve) => {
      const socket = net.connect({ host: this.host, port: this.port });
      let response = '';
      let settled = false;

      const settle = (result: ScanResult) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(result);
      };

      socket.setTimeout(this.timeoutMs);
      socket.on('timeout', () => settle('error'));
      socket.on('error', () => settle('error'));

      socket.on('data', (chunk) => { response += chunk.toString(); });

      socket.on('close', () => {
        if (settled) return;
        const line = response.trim();
        if (line.endsWith('OK')) {
          settle('clean');
        } else if (line.includes('FOUND')) {
          settle('infected');
        } else {
          settle('error');
        }
      });

      socket.on('connect', () => {
        socket.write(frame);
        socket.end();
      });
    });
  }
}

let _scanner: FileScanner | null = null;

export function getFileScanner(): FileScanner {
  if (!_scanner) {
    _scanner = config.fileScanning.clamavEnabled
      ? new ClamAvFileScanner(config.fileScanning.clamavHost, config.fileScanning.clamavPort)
      : new NoOpFileScanner();
  }
  return _scanner;
}

export function setFileScannerForTests(scanner: FileScanner): void {
  _scanner = scanner;
}

export function resetFileScannerForTests(): void {
  _scanner = null;
}
