import { z } from 'zod';

/**
 * Outbound notification channels (HeoPress P10 tasks 5.2, 5.5; spec agents/notifications): shared by the CMS
 * (validation) and Studio (the settings form).
 *
 * The target (webhook URL, signing secret, Telegram bot token) is write-only: a response shows only `targetHint`
 * (the host). On update, omit `target` to keep the current one.
 */

export const NOTIFICATION_CHANNEL_KINDS = ['wecom', 'feishu', 'dingtalk', 'telegram', 'webhook'] as const;
export const NotificationChannelKindSchema = z.enum(NOTIFICATION_CHANNEL_KINDS);
export type NotificationChannelKind = z.infer<typeof NotificationChannelKindSchema>;

/** Event kinds a channel can subscribe to. */
export const NOTIFICATION_EVENT_KINDS = ['approval', 'veto', 'incident', 'budget', 'goal', 'run'] as const;
export const NotificationEventKindSchema = z.enum(NOTIFICATION_EVENT_KINDS);
export type NotificationEventKind = z.infer<typeof NotificationEventKindSchema>;

const httpsUrl = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((v) => /^https:\/\//i.test(v), { message: 'Use an https URL.' });

/** Webhook-style target: WeCom, Feishu, DingTalk and the generic webhook. `secret` is the signing secret. */
export const NotificationWebhookTargetSchema = z.object({
  url: httpsUrl,
  secret: z.string().min(1).max(256).optional(),
});
/** Telegram target: the bot token and the chat to post to. */
export const NotificationTelegramTargetSchema = z.object({
  token: z.string().trim().regex(/^\d+:[A-Za-z0-9_-]{20,}$/, { message: 'Not a Telegram bot token.' }),
  chatId: z.string().trim().regex(/^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/, { message: 'Not a Telegram chat id.' }),
});
export type NotificationChannelTarget =
  | z.infer<typeof NotificationWebhookTargetSchema>
  | z.infer<typeof NotificationTelegramTargetSchema>;

const fields = {
  name: z.string().trim().min(1).max(100),
  events: z.array(NotificationEventKindSchema).max(NOTIFICATION_EVENT_KINDS.length),
  /** Base of the Studio link, e.g. `https://cms.example.com/console`. Null: the instance's public URL. */
  linkBaseUrl: z
    .string()
    .trim()
    .url()
    .refine((v) => /^https?:\/\//i.test(v), { message: 'Use an http(s) URL.' })
    .transform((v) => v.replace(/\/+$/, ''))
    .nullable()
    .optional(),
  enabled: z.boolean().optional(),
};

export const NotificationChannelCreateSchema = z.discriminatedUnion('kind', [
  z.object({ ...fields, kind: z.literal('telegram'), target: NotificationTelegramTargetSchema }),
  ...(['wecom', 'feishu', 'dingtalk', 'webhook'] as const).map((kind) =>
    z.object({ ...fields, kind: z.literal(kind), target: NotificationWebhookTargetSchema }),
  ) as [
    z.ZodObject<typeof fields & { kind: z.ZodLiteral<'wecom'>; target: typeof NotificationWebhookTargetSchema }>,
    z.ZodObject<typeof fields & { kind: z.ZodLiteral<'feishu'>; target: typeof NotificationWebhookTargetSchema }>,
    z.ZodObject<typeof fields & { kind: z.ZodLiteral<'dingtalk'>; target: typeof NotificationWebhookTargetSchema }>,
    z.ZodObject<typeof fields & { kind: z.ZodLiteral<'webhook'>; target: typeof NotificationWebhookTargetSchema }>,
  ],
]);
export type NotificationChannelCreateInput = z.infer<typeof NotificationChannelCreateSchema>;

/** Update: every field optional; `target` replaces the whole target (validated against the channel's kind). */
export const NotificationChannelUpdateSchema = z.object({
  name: fields.name.optional(),
  events: fields.events.optional(),
  linkBaseUrl: fields.linkBaseUrl,
  enabled: z.boolean().optional(),
  target: z.unknown().optional(),
});
export type NotificationChannelUpdateInput = z.infer<typeof NotificationChannelUpdateSchema>;

export interface NotificationChannelResource {
  id: string;
  name: string;
  kind: NotificationChannelKind;
  /** The target host only, e.g. `qyapi.weixin.qq.com`. */
  targetHint: string;
  events: NotificationEventKind[];
  linkBaseUrl: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** Recent delivery counts by status. */
  deliveries?: { pending: number; sent: number; failed: number };
}

export interface NotificationDeliveryResource {
  id: string;
  channelId: string;
  event: string;
  title: string;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  sentAt: string | null;
  createdAt: string;
}
