import { describe, expect, it, vi } from 'vitest';
import { AISecureHarness } from '../ai-harness';
import { VersionConflictError, versionRequired, type ItemService } from '../item-service';

/**
 * Item versions through the agent entry point (HeoPress P04 task 1.2): the AI
 * `updateItem` skill hands the agent's version to ItemService, and its 409 /
 * 428 reach the agent unchanged. The schema the governed path validates
 * against requires the version (g2-agent-tool-schemas fixture).
 */

function harnessWith(patch: ItemService['patch']) {
  const itemService = { patch: vi.fn(patch) } as unknown as ItemService;
  const harness = new AISecureHarness({ db: {} as never, siteId: 's1', itemService });
  return { skill: harness.validateSkill('updateItem')!, itemService };
}

describe('AI updateItem skill', () => {
  it('passes the agent’s expectedVersion to ItemService.patch', async () => {
    const { skill, itemService } = harnessWith(async () => ({ id: 'a', version: 13 }) as never);
    await skill.handler!({ collection: 'posts', id: 'a', data: { title: 'x' }, expectedVersion: 12 });
    expect(itemService.patch).toHaveBeenCalledWith('posts', 'a', { data: { title: 'x' }, expectedVersion: 12 });
  });

  it('without a version the service refuses (428) and nothing is written', async () => {
    const { skill, itemService } = harnessWith(async (_c, _i, p) => {
      if (p.expectedVersion === undefined) throw versionRequired();
      return {} as never;
    });
    await expect(skill.handler!({ collection: 'posts', id: 'a', data: { title: 'x' } })).rejects.toMatchObject({
      code: 'VERSION_REQUIRED',
      status: 428,
    });
    expect(itemService.patch).toHaveBeenCalledWith('posts', 'a', { data: { title: 'x' }, expectedVersion: undefined });
  });

  it('a stale version surfaces as VERSION_CONFLICT with the current version', async () => {
    const { skill } = harnessWith(async () => {
      throw new VersionConflictError(13, ['title']);
    });
    await expect(
      skill.handler!({ collection: 'posts', id: 'a', data: { title: 'x' }, expectedVersion: 12 }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409, currentVersion: 13, changedFields: ['title'] });
  });
});
