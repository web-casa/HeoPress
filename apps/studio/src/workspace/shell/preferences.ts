import type { StudioPreferences } from '@heopress/contracts';
import { getApiClient } from '@/lib/api';

/** Save part of `users.preferences.studio`; the server merges it field by field (p07a task 1.2). */
export async function saveStudioPreferences(patch: StudioPreferences): Promise<void> {
  await getApiClient().me.updatePreferences({ studio: patch });
}
