// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * Example HeoPress extension: email-setup.
 *
 * Illustrates the intended split for the email feature:
 *
 *   - The EXTENSION owns the trigger and any UI. Here it exposes a tiny
 *     endpoint (`POST /extensions/email-setup/notify`) that an external
 *     system — or a Studio panel you build — calls when it wants to send mail.
 *   - HEOPRESS owns the transport (SMTP / MailChannels) and the template +
 *     layout store. The extension never talks SMTP; it POSTs to HeoPress's
 *     core endpoint `POST /api/v1/email/send` with a `templateKey` and the
 *     variables the template expects.
 *
 * The endpoint extension is loaded by the CMS extension sandbox, which passes a
 * capability-checked context. Plugins have no environment access (HeoPress P12):
 * the manifest declares the HeoPress host in `outboundHosts` (`ctx.fetch` reaches
 * only it), the API token as the secret `secrets:heopress-api-token`
 * (`ctx.secrets.get`), and the endpoint itself as `ext:endpoints`. The base URL,
 * site id and default template are manifest settings.
 */

import { Hono } from 'hono';
import { z } from 'zod';

/** The part of the sandbox context this plugin uses. */
interface PluginContext {
  fetch: typeof fetch;
  secrets: { get(name: string): Promise<string | null> };
  config?: Record<string, unknown>;
}

/** Body the trigger sends us. `to` + the template variables. */
const NotifySchema = z.object({
  to: z.array(z.string().email()).min(1),
  variables: z.record(z.string(), z.unknown()).default({}),
  /** Optional override; otherwise the manifest config `templateKey` is used. */
  templateKey: z.string().optional(),
});

const setting = (ctx: PluginContext, key: string, fallback: string) => {
  const value = ctx.config?.[key];
  return typeof value === 'string' && value ? value : fallback;
};

export default (ctx: PluginContext) => ({
  handler(app: Hono) {
    app.post('/notify', async (c) => {
      const parsed = NotifySchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Invalid body', details: parsed.error.format() }, 400);
      }
      const { to, variables, templateKey } = parsed.data;
      const baseUrl = setting(ctx, 'baseUrl', 'https://cms.example.com');
      const siteId = setting(ctx, 'siteId', '');
      const token = await ctx.secrets.get('heopress-api-token');

      // Hand off to HeoPress's core EmailService. The extension does NOT render or
      // send mail itself — it asks HeoPress to render the stored template and
      // deliver it through the configured transport.
      const res = await ctx.fetch(`${baseUrl}/api/v1/email/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(siteId ? { 'x-site-id': siteId } : {}),
        },
        body: JSON.stringify({
          to,
          templateKey: templateKey ?? setting(ctx, 'templateKey', 'teammate_invite'),
          variables,
        }),
      });

      const body = (await res.json().catch(() => ({}))) as {
        data?: { sent: boolean; subject: string };
        errors?: Array<{ code: string; message?: string }>;
      };

      if (!res.ok) {
        return c.json(
          { sent: false, error: body.errors?.[0]?.message ?? body.errors?.[0]?.code ?? `HTTP ${res.status}` },
          res.status as 400,
        );
      }
      return c.json({ sent: true, subject: body.data?.subject });
    });
  },
});
