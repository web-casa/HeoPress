import { describe, expect, it } from 'vitest';
import { draftBody } from '../notifications-page';

const base = { name: ' Ops ', kind: 'feishu' as const, url: '', secret: '', token: '', chatId: '', events: ['veto' as const], linkBaseUrl: '' };

describe('notification channel form (P10 task 5.2)', () => {
  it('creates with kind and target', () => {
    expect(draftBody({ ...base, url: 'https://open.feishu.cn/open-apis/bot/v2/hook/x', secret: 'hook-secret' }, false)).toEqual({
      name: 'Ops',
      kind: 'feishu',
      events: ['veto'],
      linkBaseUrl: null,
      target: { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/x', secret: 'hook-secret' },
    });
  });
  it('editing without a new target keeps the stored one (no target sent, no kind change)', () => {
    expect(draftBody({ ...base, linkBaseUrl: 'https://cms.example.com/console' }, true)).toEqual({ name: 'Ops', events: ['veto'], linkBaseUrl: 'https://cms.example.com/console' });
  });
  it('Telegram sends token and chat id', () => {
    expect(draftBody({ ...base, kind: 'telegram', token: '1:abc', chatId: '-100' }, false).target).toEqual({ token: '1:abc', chatId: '-100' });
  });
});
