import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5442;
const runId = Date.now();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-notifications-pg-'));
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'docforum', password: 'docforum', port: PORT, persistent: false });
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

describe('notification inbox', () => {
  let app: App;
  let prisma: Prisma;
  let notifications: typeof import('../../src/modules/notifications/services/index.js');
  let owner: { id: string; token: string };
  let other: { id: string; token: string };

  async function signup(label: string) {
    const response = await request(app).post('/auth/signup').send({
      role: 'patient',
      email: `${label}-${runId}@example.com`,
      password: 'longenough123',
      fullName: `Notification ${label}`,
    });
    expect(response.status).toBe(200);
    return { id: response.body.user.id as string, token: response.body.accessToken as string };
  }

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_test');
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    process.env.DATABASE_URL = databaseUrl;
    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    const authServices = await import('../../src/modules/auth/services/index.js');
    notifications = await import('../../src/modules/notifications/services/index.js');
    app = appModule.createApp();
    prisma = dbModule.prisma;
    authServices.setEmailSender(async () => {});
    owner = await signup('owner');
    other = await signup('other');
  }, 180_000);

  afterAll(async () => {
    const authServices = await import('../../src/modules/auth/services/index.js');
    authServices.resetEmailSender();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('requires authentication and prevents reading or marking another user\'s notification', async () => {
    const notification = await notifications.notify(owner.id, 'booking_confirmed', {
      appointmentId: '00000000-0000-4000-8000-000000000001',
    });

    expect((await request(app).get('/notifications')).status).toBe(401);
    const otherList = await request(app).get('/notifications').set('Authorization', `Bearer ${other.token}`);
    expect(otherList.status).toBe(200);
    expect(otherList.body.items).toHaveLength(0);

    const crossUserRead = await request(app)
      .post(`/notifications/${notification.id}/read`)
      .set('Authorization', `Bearer ${other.token}`);
    expect(crossUserRead.status).toBe(404);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: notification.id } })).readAt).toBeNull();
  });

  it('validates typed payloads and rejects malformed cursors', async () => {
    await expect(notifications.notify(owner.id, 'booking_confirmed', { appointmentId: 'not-a-uuid' })).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_NOTIFICATION_PAYLOAD',
    });

    const response = await request(app)
      .get('/notifications?cursor=not-a-valid-cursor')
      .set('Authorization', `Bearer ${owner.token}`);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_CURSOR');
  });

  it('returns unread-only keyset pages without duplicates and supports read-all', async () => {
    await notifications.markAllMyNotificationsRead(owner.id);
    await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        notifications.notify(owner.id, 'booking_confirmed', {
          appointmentId: `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
        }),
      ),
    );

    const firstPage = await request(app)
      .get('/notifications?unread=true&limit=2')
      .set('Authorization', `Bearer ${owner.token}`);
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.items).toHaveLength(2);
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));

    const secondPage = await request(app)
      .get('/notifications')
      .query({ unread: 'true', limit: 2, cursor: firstPage.body.nextCursor as string })
      .set('Authorization', `Bearer ${owner.token}`);
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.items).toHaveLength(1);
    const ids = [...firstPage.body.items, ...secondPage.body.items].map((item: { id: string }) => item.id);
    expect(new Set(ids).size).toBe(3);

    const count = await request(app).get('/notifications/unread-count').set('Authorization', `Bearer ${owner.token}`);
    expect(count.body.count).toBe(3);
    const marked = await request(app).post('/notifications/read-all').set('Authorization', `Bearer ${owner.token}`);
    expect(marked.body.updated).toBe(3);
    const after = await request(app).get('/notifications/unread-count').set('Authorization', `Bearer ${owner.token}`);
    expect(after.body.count).toBe(0);
  });

  it('keeps the in-app write when a channel adapter fails', async () => {
    const unregister = notifications.registerChannelAdapter({ channel: 'email', send: async () => { throw new Error('provider failure'); } });
    try {
      const notification = await notifications.notify(owner.id, 'results_available', {
        labOrderId: '00000000-0000-4000-8000-000000000099',
      });
      expect(await prisma.notification.findUnique({ where: { id: notification.id } })).toMatchObject({
        id: notification.id,
        channel: 'in_app',
      });
    } finally {
      unregister();
    }
  });
});