/**
 * Outbound notification channels of the current site (HeoPress P10 tasks 5.2, 5.5):
 *
 *   GET    /notification-channels                 list (targets never returned, only the host)
 *   POST   /notification-channels                 create
 *   GET    /notification-channels/deliveries      recent deliveries (?channelId=)
 *   GET    /notification-channels/:id             read
 *   PATCH  /notification-channels/:id             update (target: omit keeps it)
 *   DELETE /notification-channels/:id             delete
 *   POST   /notification-channels/:id/test        send a test message now
 *
 * A control-plane path: site administrators only.
 */
import { Hono, type Context } from 'hono';
import { NotificationChannelCreateSchema, NotificationChannelUpdateSchema } from '@heopress/contracts/schemas';
import type { AppEnv } from '../env';
import { NotificationChannelError, NotificationChannelService } from '../modules/notifications/channels/channel-service';

export const notificationChannelsRouter = new Hono<AppEnv>();

function serviceFor(c: Context<AppEnv>): NotificationChannelService {
  const env = c.env as unknown as Record<string, string | undefined> | undefined;
  const auth = c.get('auth');
  return new NotificationChannelService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    keys: c.get('runtime').keys,
    userId: auth?.userId ?? null,
    publicUrl: env?.HEOPRESS_PUBLIC_URL?.trim() || process.env.HEOPRESS_PUBLIC_URL?.trim() || null,
  });
}

async function run(c: Context<AppEnv>, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NotificationChannelError) {
      return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status);
    }
    throw err;
  }
}

function validation(c: Context<AppEnv>, issues: Array<{ message: string; path: PropertyKey[] }>): Response {
  // Messages and paths only: never echo the submitted values (they may hold a token).
  return c.json({ errors: issues.map((i) => ({ code: 'VALIDATION', message: i.message, path: i.path.map(String) })) }, 400);
}

notificationChannelsRouter.get('/', (c) => run(c, async () => c.json({ data: await serviceFor(c).list() })));

notificationChannelsRouter.post('/', (c) =>
  run(c, async () => {
    const parsed = NotificationChannelCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validation(c, parsed.error.issues);
    return c.json({ data: await serviceFor(c).create(parsed.data) }, 201);
  }),
);

notificationChannelsRouter.get('/deliveries', (c) =>
  run(c, async () => {
    const limit = Number(c.req.query('limit') ?? 50);
    return c.json({ data: await serviceFor(c).deliveries(c.req.query('channelId') || undefined, Number.isFinite(limit) ? limit : 50) });
  }),
);

notificationChannelsRouter.get('/:id', (c) => run(c, async () => c.json({ data: await serviceFor(c).get(c.req.param('id')) })));

notificationChannelsRouter.patch('/:id', (c) =>
  run(c, async () => {
    const parsed = NotificationChannelUpdateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validation(c, parsed.error.issues);
    return c.json({ data: await serviceFor(c).update(c.req.param('id'), parsed.data) });
  }),
);

notificationChannelsRouter.delete('/:id', (c) =>
  run(c, async () => {
    await serviceFor(c).remove(c.req.param('id'));
    return c.body(null, 204);
  }),
);

notificationChannelsRouter.post('/:id/test', (c) => run(c, async () => c.json({ data: await serviceFor(c).test(c.req.param('id')) })));
