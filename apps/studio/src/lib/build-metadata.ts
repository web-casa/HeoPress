// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import type { BuildMetadata } from '@heopress/contracts';

const UNKNOWN_METADATA_VALUE = 'unknown';

type StudioEnv = Pick<
  ImportMetaEnv,
  | 'VITE_HEOPRESS_VERSION'
  | 'VITE_HEOPRESS_GIT_SHA'
  | 'VITE_HEOPRESS_BUILD_TIME'
  | 'VITE_HEOPRESS_RELEASE_CHANNEL'
>;

function valueOrUnknown(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : UNKNOWN_METADATA_VALUE;
}

export function getStudioBuildMetadata(env: StudioEnv = import.meta.env): BuildMetadata {
  return {
    version: valueOrUnknown(env.VITE_HEOPRESS_VERSION),
    gitSha: valueOrUnknown(env.VITE_HEOPRESS_GIT_SHA),
    buildTime: valueOrUnknown(env.VITE_HEOPRESS_BUILD_TIME),
    releaseChannel: valueOrUnknown(env.VITE_HEOPRESS_RELEASE_CHANNEL),
  };
}

export const studioBuildMetadata = getStudioBuildMetadata();
