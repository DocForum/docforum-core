// Issue #333: malformed JSON, oversized bodies and unsupported encodings
// return 400/413/415 with stable codes instead of a 500, are logged at
// warn (not error), and the raw body never reaches the logs.
//
// No database: express.json() runs before any route, so a body error is
// answered without touching Postgres. The lab-result raw-body route keeps
// its own LAB_RESULT_TOO_LARGE code; that is asserted in
// lab-result-attachment.test.mts, which needs a facility and an order.
import zlib from 'node:zlib';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

type App = ReturnType<typeof import('../../src/app.js').createApp>;

// A value that must never appear in any log line.
const SECRET = 'patient-diagnosis-and-password-hunter2';

describe('body-parser errors (issue #333)', () => {
  let app: App;
  const logged: { level: string; args: unknown[] }[] = [];

  beforeAll(async () => {
    const loggerModule = await import('../../src/logger.js');
    // Every request logger is a child of the root logger (request-id.ts).
    // Capture what the error handler writes through it.
    const capture = (level: string) => (...args: unknown[]) => {
      logged.push({ level, args });
    };
    const fakeChild = {
      info: capture('info'),
      warn: capture('warn'),
      error: capture('error'),
      debug: capture('debug'),
      child: () => fakeChild,
    };
    vi.spyOn(loggerModule.logger, 'child').mockReturnValue(fakeChild as never);
    const appModule = await import('../../src/app.js');
    app = appModule.createApp();
  });

  afterEach(() => {
    logged.length = 0;
  });

  function expectWarnOnlyWithoutBody() {
    expect(logged.some((entry) => entry.level === 'warn')).toBe(true);
    expect(logged.some((entry) => entry.level === 'error')).toBe(false);
    expect(JSON.stringify(logged)).not.toContain(SECRET);
  }

  it('malformed JSON → 400 INVALID_JSON, logged at warn without the body', async () => {
    const res = await request(app)
      .post('/auth/login')
      .set('Content-Type', 'application/json')
      .send(`{"email":"a@b.c","password":"${SECRET}"`); // missing closing brace

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'The request body is not valid JSON.', code: 'INVALID_JSON' });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expectWarnOnlyWithoutBody();
  });

  it('oversized JSON body → 413 PAYLOAD_TOO_LARGE', async () => {
    const big = JSON.stringify({ notes: SECRET.repeat(10_000) }); // > express.json's 100kb default
    const res = await request(app).post('/auth/login').set('Content-Type', 'application/json').send(big);

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
    expectWarnOnlyWithoutBody();
  });

  it('unsupported Content-Encoding → 415 UNSUPPORTED_ENCODING', async () => {
    const res = await request(app)
      .post('/auth/login')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'compress')
      .send(JSON.stringify({ password: SECRET }));

    expect(res.status).toBe(415);
    expect(res.body.code).toBe('UNSUPPORTED_ENCODING');
    expectWarnOnlyWithoutBody();
  });

  it('unsupported charset → 415 UNSUPPORTED_CHARSET', async () => {
    const res = await request(app)
      .post('/auth/login')
      .set('Content-Type', 'application/json; charset=latin1')
      .send(JSON.stringify({ password: SECRET }));

    expect(res.status).toBe(415);
    expect(res.body.code).toBe('UNSUPPORTED_CHARSET');
    expectWarnOnlyWithoutBody();
  });

  it('a corrupt gzip body (http-error 400 with no type) → 400 INVALID_REQUEST_BODY', async () => {
    const res = await request(app)
      .post('/auth/login')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .send(`{"password":"${SECRET}"}`); // claims gzip, isn't

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_REQUEST_BODY');
    expectWarnOnlyWithoutBody();
  });

  it('a valid gzip body that decompresses to bad JSON → 400 INVALID_JSON', async () => {
    const gz = zlib.gzipSync(Buffer.from(`{"password":"${SECRET}"`));
    const server = app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      // Raw fetch: superagent re-serialises a Buffer under a JSON content type.
      const res = await fetch(`http://127.0.0.1:${port}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        body: gz,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('INVALID_JSON');
    } finally {
      server.close();
    }
    expectWarnOnlyWithoutBody();
  });
});
